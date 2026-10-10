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
import { sectionHeaderStyle, sectionHeaderText, hintStyle } from './ui-kit.js';

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
  /** Special action entries (start a chat, a desktop command) instead of showing an object. */
  action?: 'chat' | 'expose';
  /** The typed query, carried on the chat action entry. */
  query?: string;
}

/** Sentinel id for the synthetic "Chat about …" entry shown when nothing matches. */
const CHAT_ENTRY_ID = 'palette:new-chat' as AbjectId;

/**
 * Desktop commands listed ahead of the objects (they match by name and
 * description like any entry). Each names the action activateEntry runs.
 */
const PALETTE_COMMANDS: readonly PaletteEntry[] = [
  {
    id: 'palette:expose' as AbjectId,
    name: 'Show All Windows',
    description: 'Expos\u00E9: spread every open window to pick one (F3 or Ctrl+\u2191)',
    action: 'expose',
  },
];

const PALETTE_WIDTH = 520;
const PALETTE_HEIGHT = 380;
const SEARCH_HEIGHT = 44;
const PALETTE_HINT = '\u2191\u2193 to move \u00B7 Enter to open \u00B7 Esc to close';

export class CommandPaletteAbject extends Abject {
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private searchInputId?: AbjectId;
  private resultsListId?: AbjectId;
  private headerLabelId?: AbjectId;
  private hintLabelId?: AbjectId;

  private chatManagerId?: AbjectId;
  private query = '';
  private entries: PaletteEntry[] = [];
  private filtered: PaletteEntry[] = [];
  private selectedIndex = 0;
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
    this.chatManagerId = await this.discoverDep('ChatManager') ?? undefined;
    await this.fetchTheme();
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
        if (aspect === 'submit') {
          // Launch the highlighted result (Enter), not just the first.
          const entry = this.filtered[this.selectedIndex] ?? this.filtered[0];
          if (entry) await this.activateEntry(entry);
          else this.playEffect('shake');
          return;
        }
        this.query = String(value ?? '');
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

    // Arrow-key navigation. The single-line search input keeps text focus but
    // doesn't consume the arrows, so the window bubbles them to us here as
    // 'keyUnhandled'. (Esc dismissal is handled via windowCloseRequested.)
    this.on('keyUnhandled', async (msg: AbjectMessage) => {
      const { key } = msg.payload as { key?: string };
      if (key !== 'ArrowDown' && key !== 'ArrowUp') return;
      if (this.filtered.length === 0) return;
      const delta = key === 'ArrowDown' ? 1 : -1;
      this.selectedIndex = Math.max(0, Math.min(this.filtered.length - 1, this.selectedIndex + delta));
      await this.moveSelection();
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
    // Clamp to the display: phone canvases are far smaller than the
    // desktop-centered 520×380 default, which would overflow them.
    const width = Math.min(PALETTE_WIDTH, Math.floor(display.width * 0.94));
    const height = Math.min(PALETTE_HEIGHT, Math.floor(display.height * 0.6));
    const x = Math.max(0, Math.floor((display.width  - width)  / 2));
    const y = Math.max(40, Math.floor((display.height - height) / 3));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId, 'createWindowAbject', {
        title: 'Command Palette',
        rect: { x, y, width, height },
        chromeless: true,
        resizable: false,
        zIndex: 9000,
      }),
    );

    // The palette owns the user's attention while it shows: the desktop
    // recedes behind it. closePalette lifts it on every close path.
    await this.setModal(this.windowId, true);

    await this.request(request(this.id, this.windowId, 'addDependent', {}));

    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 16, right: 16, bottom: 16, left: 16 },
        spacing: 8,
      }),
    );

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId, 'create', {
        specs: [
          {
            type: 'label',
            windowId: this.windowId,
            text: sectionHeaderText(this.theme, 'Open Anything'),
            style: sectionHeaderStyle(this.theme, 14),
          },
          {
            type: 'textInput',
            windowId: this.windowId,
            placeholder: 'Type to search objects, or ask a question to start a chat…',
            text: '',
          },
          {
            type: 'list',
            windowId: this.windowId,
            items: this.filtered.map(toListItem),
            selectedIndex: this.filtered.length > 0 ? 0 : -1,
            itemHeight: 36,
          },
          {
            type: 'label',
            windowId: this.windowId,
            text: PALETTE_HINT,
            style: { ...hintStyle(this.theme, 11), wordWrap: false, selectable: false },
          },
        ],
      }),
    );

    [this.headerLabelId, this.searchInputId, this.resultsListId, this.hintLabelId] = widgetIds;

    await this.request(request(this.id, this.searchInputId, 'addDependent', {}));
    await this.request(request(this.id, this.resultsListId, 'addDependent', {}));

    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.headerLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 22 } },
        { widgetId: this.searchInputId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: SEARCH_HEIGHT } },
        { widgetId: this.resultsListId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.hintLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: 16 } },
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
    this.headerLabelId = undefined;
    this.hintLabelId = undefined;
    this.query = '';
    this.filtered = [];
    await this.setModal(wid, false);
    try {
      await this.request(
        request(this.id, this.widgetManagerId, 'destroyWindowAbject', { windowId: wid }),
      );
    } catch { /* already gone */ }
    return true;
  }

  /** Mark the palette window modal (the rest of the desktop recedes) or not. */
  private async setModal(windowId: AbjectId, modal: boolean): Promise<void> {
    try {
      await this.setWindowModal(windowId, modal);
    } catch { /* window gone; closing it clears the flag anyway */ }
  }

  /** Play a one-shot slab effect on the open palette (visual only). */
  private playEffect(effect: string, color?: string): void {
    if (!this.windowId) return;
    try {
      this.playWindowEffect(this.windowId, effect, color);
    } catch { /* window gone */ }
  }

  private async activateEntry(entry: PaletteEntry): Promise<void> {
    if (entry.action === 'expose') {
      // Step aside first, then spread the windows on the user's screen.
      await this.closePalette();
      if (!this.widgetManagerId) return;
      try {
        await this.request(request(this.id, this.widgetManagerId, 'showExpose', {}));
      } catch { /* no client to show it on */ }
      return;
    }
    if (entry.action === 'chat') {
      const text = (entry.query ?? this.query).trim();
      const chatId = await this.startChat(text);
      if (!chatId) {
        // The chat could not start: keep the palette (and the typed text) up.
        this.playEffect('shake');
        return;
      }
      // Step aside first so the new chat window arrives in front, not receded.
      await this.closePalette();
      try {
        await this.request(request(this.id, chatId, 'sendMessage', { message: text }), 10000);
      } catch { /* the chat exists; its own window reports what happened */ }
      return;
    }
    // Close (lifting the modal depth) before the chosen window shows, so it
    // arrives at full depth instead of receded behind the palette.
    await this.closePalette();
    this.send(event(this.id, entry.id, 'show', {}));
  }

  /**
   * Spawn a fresh chat conversation titled with the typed query. Returns the
   * new chat's id, or undefined when no conversation could be created.
   */
  private async startChat(text: string): Promise<AbjectId | undefined> {
    if (!text) return undefined;
    if (!this.chatManagerId) {
      this.chatManagerId = await this.discoverDep('ChatManager') ?? undefined;
    }
    if (!this.chatManagerId) return undefined;
    try {
      const res = await this.request<{ conversationId: string; chatId: AbjectId }>(
        request(this.id, this.chatManagerId, 'newConversation', { title: text.slice(0, 60) }),
        10000,
      );
      return res?.chatId || undefined;
    } catch {
      return undefined; /* chat manager unavailable */
    }
  }

  // ── Search / filter ─────────────────────────────────────────────────

  private async refreshEntries(): Promise<void> {
    if (!this.registryId) { this.entries = [...PALETTE_COMMANDS]; return; }
    let summaries: RegistrySummary[] = [];
    try {
      summaries = await this.request<RegistrySummary[]>(
        request(this.id, this.registryId, 'listSummaries', {}),
      );
    } catch {
      summaries = [];
    }

    this.entries = [
      ...PALETTE_COMMANDS,
      ...summaries
        .filter((s) => hasShowMethod(s))
        .map((s) => ({
          id: s.id,
          name: s.name ?? '',
          description: s.description ?? '',
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ];
  }

  private applyFilter(): void {
    const q = this.query.trim().toLowerCase();
    if (!q) {
      this.filtered = this.entries.slice(0, 50);
      return;
    }
    const matches = this.entries
      .filter((e) =>
        e.name.toLowerCase().includes(q) ||
        e.description.toLowerCase().includes(q))
      .slice(0, 50);
    if (matches.length === 0) {
      // No object matches — offer to start a chat seeded with the query.
      const text = this.query.trim();
      this.filtered = [{
        id: CHAT_ENTRY_ID,
        name: `◉  Chat about “${text}”`,
        description: 'Start a new conversation',
        action: 'chat',
        query: text,
      }];
      return;
    }
    this.filtered = matches;
  }

  private scheduleRebuild(): void {
    if (this.rebuildScheduled) return;
    this.rebuildScheduled = true;
    this.setTimer(async () => {
      this.rebuildScheduled = false;
      await this.rebuildResults();
    }, 30);
  }

  private async rebuildResults(): Promise<void> {
    if (!this.resultsListId) return;
    this.applyFilter();
    this.selectedIndex = 0; // new results → highlight the top match
    try {
      await this.request(request(this.id, this.resultsListId, 'update', {
        items: this.filtered.map(toListItem),
        selectedIndex: this.filtered.length > 0 ? 0 : -1,
      }));
    } catch { /* widget gone */ }
  }

  /** Push the current selection to the list (which scrolls it into view). */
  private async moveSelection(): Promise<void> {
    if (!this.resultsListId) return;
    try {
      await this.request(request(this.id, this.resultsListId, 'update', { selectedIndex: this.selectedIndex }));
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
