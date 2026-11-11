/**
 * TerminalView — a real terminal window on the desktop, with tabs.
 *
 * One window, many approved shells. Each tab is one `TerminalSession`, opened
 * through the `Terminal` capability (the only object that may start a process)
 * and shown in the same canvas: switching tabs repaints the canvas from that
 * session's own screen, so several shells run at once while only the active one
 * is on display.
 *
 * The window still holds no shell capability of its own. It asks `Terminal` for
 * a session (which asks PermissionBroker for the directory and then for the
 * shell, with a prompt that says everything typed afterwards runs unprompted),
 * it paints and types into the session it was given, and it can neither spawn a
 * process nor reach a session that is not its own. Closing a tab ends exactly
 * that shell; closing the window ends all of them.
 *
 * The chrome is composed widgets: a strip of one button per tab with its own
 * close button, a `+ New tab` button, a `Rename` button that reveals a text
 * input row, and the names the person chose. The tabs themselves are modelled
 * in `terminal-tabs.ts`, which is where the ordering, naming and neighbour rules
 * live.
 *
 * The screen is libghostty's: `TerminalSession` hands back styled cells from
 * libghostty-vt's snapshot, and this view composes them into ONE canvas draw
 * batch that always begins with a clear. Nothing here parses ANSI and nothing
 * here falls back to xterm.
 *
 * Clipboard: a terminal program cannot read the clipboard behind the person's
 * back. OSC 52 replies from the emulator are dropped by the session, and the
 * two clipboard paths this view offers (paste, copy-selection) go through the
 * Clipboard capability, which asks PermissionBroker itself.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { require, ensure, invariant } from '../core/contracts.js';
import { Log } from '../core/timed-log.js';
import { fontStacks } from './widgets/widget-types.js';
import type { ThemeData } from '../core/theme-data.js';
import {
  activeTab,
  addTab,
  emptyTabSet,
  findTab,
  labelBudget,
  removeTab,
  renameTab as renameTabInSet,
  selectTab,
  tabLabel,
  tabSetInvariants,
  MAX_TABS,
  type TabSetState,
  type TerminalTab,
} from './terminal-tabs.js';

const log = new Log('TerminalView');

export const TERMINAL_VIEW_ID = 'abjects:terminal-view' as AbjectId;
const TERMINAL_VIEW_INTERFACE: InterfaceId = 'abjects:terminal-view';

/** Window geometry, in canvas pixels. */
const WIN_W = 900;
const WIN_H = 600;

/** One character cell. Monospace advance is ~0.6em for the code stack. */
const FONT_SIZE = 14;
const CELL_W = 8.4;
const CELL_H = 18;

/** The tab strip's band and the height of a control inside it. */
const STRIP_H = 44;
const TAB_H = 28;
const RENAME_H = 32;

/** Repaint coalescing: the session already throttles its own output events. */
const REPAINT_MS = 16;

/** How much retained output to scan per frame when watching for mouse modes. */
const MOUSE_SCAN_CHARS = 65536;

/** Opening a tab can wait while the person reads a permission prompt. */
const PERMISSION_WAIT_MS = 31 * 60 * 1000;

const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 2;
const MAX_ROWS = 200;

// ── The screen, as the session reports it ────────────────────────────────

/** One styled cell. Omitted fields mean "the default". */
export interface TerminalCell {
  text: string;
  width: 1 | 2;
  fg?: string;
  bg?: string;
  ulColor?: string;
  bold?: true;
  italic?: true;
  dim?: true;
  inverse?: true;
  hidden?: true;
  strike?: true;
  underline?: string;
  link?: string;
}

export interface TerminalRow { wrapped: boolean; cells: TerminalCell[] }

export interface TerminalCursor {
  x: number;
  y: number;
  visible: boolean;
  shape?: string;
  blinking?: boolean;
}

/** What `TerminalSession.screen` answers. */
export interface TerminalScreen {
  sessionId: AbjectId;
  seq: number;
  revision?: number;
  ready: boolean;
  cols: number;
  rows: number;
  title?: string;
  screen: TerminalRow[];
  totalRows?: number;
  startRow?: number;
  visibleRows?: number;
  synchronizedOutputActive?: boolean;
  cursor: TerminalCursor | null;
  foreground?: string;
  background?: string;
  cursorColor?: string;
  palette?: string[];
  exitCode?: number;
  screenError?: string;
  unchanged?: true;
}

/** A canvas draw command, in the batch vocabulary WidgetManager documents. */
export interface DrawCommand { type: string; surfaceId: string; params: Record<string, unknown> }

/** Everything the painter needs that does not come from the screen itself. */
export interface FrameOptions {
  cellW: number;
  cellH: number;
  fontSize: number;
  fontFamily: string;
  defaultFg: string;
  defaultBg: string;
  /** Inclusive character range highlighted as a selection, in cell coordinates. */
  selection?: { fromCol: number; fromRow: number; toCol: number; toRow: number } | null;
  selectionColor?: string;
}

// ── Painting ─────────────────────────────────────────────────────────────

/** The font for a run of text, from the code stack. */
function fontFor(opts: FrameOptions, bold: boolean, italic: boolean): string {
  const style = `${italic ? 'italic ' : ''}${bold ? '600 ' : ''}`;
  return `${style}${opts.fontSize}px ${opts.fontFamily}`;
}

/** The cell at a character column, or undefined past the end of the row. */
function cellAt(cells: readonly TerminalCell[], col: number): TerminalCell | undefined {
  let at = 0;
  for (const cell of cells) {
    if (at === col) return cell;
    if (at > col) return undefined;
    at += cell.width;
  }
  return undefined;
}

/**
 * Compose one complete frame: a clear, then the styled cells, then the cursor.
 *
 * This is the whole painter, kept pure so it can be exercised against real
 * libghostty cells without a desktop. Every repaint starts from a clear, so a
 * redraw replaces the previous frame instead of painting on top of it - which
 * is what makes switching tabs show the new session's screen rather than a
 * blend of two.
 */
export function composeTerminalFrame(screen: TerminalScreen | undefined, opts: FrameOptions): DrawCommand[] {
  require(opts.cellW > 0, 'a cell must have a width');
  require(opts.cellH > 0, 'a cell must have a height');

  const baseBg = screen?.background ?? opts.defaultBg;
  const baseFg = screen?.foreground ?? opts.defaultFg;
  const commands: DrawCommand[] = [{ type: 'clear', surfaceId: 'c', params: { color: baseBg } }];

  const rows = screen?.screen ?? [];
  if (!screen || !screen.ready || rows.length === 0) {
    ensure(commands[0].type === 'clear', 'every frame opens with a clear');
    return commands;
  }

  const { cellW, cellH } = opts;

  for (let r = 0; r < rows.length; r += 1) {
    const cells = rows[r]?.cells ?? [];
    if (cells.length === 0) continue;
    const y = r * cellH;

    // Backgrounds first, merged into runs so a plain row costs nothing.
    let bgRun: { start: number; color: string } | null = null;
    let col = 0;
    const flushBg = (endCol: number): void => {
      if (!bgRun) return;
      commands.push({
        type: 'rect', surfaceId: 'c',
        params: { x: bgRun.start * cellW, y, width: (endCol - bgRun.start) * cellW, height: cellH, fill: bgRun.color },
      });
      bgRun = null;
    };
    for (const cell of cells) {
      const wanted = cell.inverse ? (cell.fg ?? baseFg) : cell.bg;
      const color = wanted && wanted !== baseBg ? wanted : undefined;
      if (bgRun && bgRun.color !== color) flushBg(col);
      if (!bgRun && color) bgRun = { start: col, color };
      col += cell.width;
    }
    flushBg(col);

    // The selection sits above the backgrounds and below the glyphs.
    const sel = opts.selection;
    if (sel) {
      const top = Math.min(sel.fromRow, sel.toRow);
      const bottom = Math.max(sel.fromRow, sel.toRow);
      if (r >= top && r <= bottom) {
        const startCol = r === top ? (sel.fromRow <= sel.toRow ? sel.fromCol : sel.toCol) : 0;
        const endCol = r === bottom ? (sel.fromRow <= sel.toRow ? sel.toCol : sel.fromCol) : (screen.cols ?? col);
        // The end column is part of the selection, so the span is inclusive.
        const width = Math.max(1, endCol - startCol + 1) * cellW;
        commands.push({
          type: 'rect', surfaceId: 'c',
          params: { x: startCol * cellW, y, width, height: cellH, fill: opts.selectionColor ?? 'rgba(120,160,255,0.30)' },
        });
      }
    }

    // Glyphs, merged into runs of one style. A wide character gets its own
    // command at its own column so a proportional advance cannot shift the
    // rest of the line.
    interface TextRun { start: number; text: string; fg: string; bold: boolean; italic: boolean; strike: boolean; underline?: string; ulColor?: string }
    let run: TextRun | null = null;
    col = 0;
    const flushText = (endCol: number): void => {
      if (!run) return;
      const { start, text, fg, bold, italic, strike, underline, ulColor } = run;
      run = null;
      if (text.length === 0) return;
      commands.push({
        type: 'text', surfaceId: 'c',
        params: { text, x: start * cellW, y: y + cellH / 2, fill: fg, font: fontFor(opts, bold, italic), baseline: 'middle' },
      });
      if (strike) {
        commands.push({ type: 'line', surfaceId: 'c', params: { x1: start * cellW, y1: y + cellH / 2, x2: endCol * cellW, y2: y + cellH / 2, stroke: fg, lineWidth: 1 } });
      }
      if (underline) {
        commands.push({ type: 'line', surfaceId: 'c', params: { x1: start * cellW, y1: y + cellH - 1, x2: endCol * cellW, y2: y + cellH - 1, stroke: ulColor ?? fg, lineWidth: 1 } });
      }
    };

    for (const cell of cells) {
      if (cell.hidden || cell.text.length === 0) {
        col += cell.width;
        continue;
      }
      const fg = cell.inverse ? (cell.bg ?? baseBg) : (cell.fg ?? baseFg);
      if (cell.width === 2) {
        flushText(col);
        commands.push({
          type: 'text', surfaceId: 'c',
          params: { text: cell.text, x: col * cellW, y: y + cellH / 2, fill: fg, font: fontFor(opts, !!cell.bold, !!cell.italic), baseline: 'middle' },
        });
        col += cell.width;
        continue;
      }
      const same = run && run.fg === fg && run.bold === !!cell.bold && run.italic === !!cell.italic
        && run.strike === !!cell.strike && run.underline === cell.underline && run.ulColor === cell.ulColor;
      if (!same) {
        flushText(col);
        run = { start: col, text: '', fg, bold: !!cell.bold, italic: !!cell.italic, strike: !!cell.strike, underline: cell.underline, ulColor: cell.ulColor };
      }
      (run as TextRun).text += cell.text;
      col += cell.width;
    }
    flushText(col);
  }

  // The cursor, drawn last so it reads on top of whatever it sits on.
  const cursor = screen.cursor;
  if (cursor && cursor.visible) {
    const cx = cursor.x * cellW;
    const cy = cursor.y * cellH;
    const color = screen.cursorColor ?? baseFg;
    commands.push({ type: 'rect', surfaceId: 'c', params: { x: cx, y: cy, width: cellW, height: cellH, fill: color } });
    const under = cellAt(rows[cursor.y]?.cells ?? [], cursor.x);
    if (under && under.text.length > 0 && !under.hidden) {
      commands.push({
        type: 'text', surfaceId: 'c',
        params: { text: under.text, x: cx, y: cy + cellH / 2, fill: baseBg, font: fontFor(opts, !!under.bold, !!under.italic), baseline: 'middle' },
      });
    }
  }

  ensure(commands[0].type === 'clear', 'every frame opens with a clear');
  return commands;
}

// ── Key encoding ─────────────────────────────────────────────────────────

export interface KeyModifiers { shift?: boolean; ctrl?: boolean; alt?: boolean; meta?: boolean }

/** xterm's modifier parameter: 1 + shift + 2*alt + 4*ctrl + 8*meta. */
function modifierParam(mods: KeyModifiers): number {
  return 1 + (mods.shift ? 1 : 0) + (mods.alt ? 2 : 0) + (mods.ctrl ? 4 : 0) + (mods.meta ? 8 : 0);
}

/** A CSI sequence, carrying the modifier parameter only when there is one. */
function csi(final: string, mods: KeyModifiers): string {
  const param = modifierParam(mods);
  return param > 1 ? `\x1b[1;${param}${final}` : `\x1b[${final}`;
}

/** A CSI ~ sequence (Insert, Delete, PageUp, function keys). */
function csiTilde(number: number, mods: KeyModifiers): string {
  const param = modifierParam(mods);
  return param > 1 ? `\x1b[${number};${param}~` : `\x1b[${number}~`;
}

const FUNCTION_KEYS: Readonly<Record<string, number>> = {
  F1: 11, F2: 12, F3: 13, F4: 14, F5: 15, F6: 17, F7: 18, F8: 19, F9: 20, F10: 21, F11: 23, F12: 24,
};

/**
 * Encode a browser key event as the bytes a terminal program expects.
 *
 * Returns null for keys that produce nothing (bare modifiers, composition
 * keys) so the caller can drop them without guessing.
 */
export function encodeKey(key: string | undefined, code: string | undefined, mods: KeyModifiers = {}): string | null {
  if (!key) return null;

  switch (key) {
    case 'Enter': return mods.alt ? '\x1b\r' : '\r';
    case 'Tab': return mods.shift ? '\x1b[Z' : '\t';
    case 'Backspace': return '\x7f';
    case 'Escape': return '\x1b';
    case 'ArrowUp': return csi('A', mods);
    case 'ArrowDown': return csi('B', mods);
    case 'ArrowRight': return csi('C', mods);
    case 'ArrowLeft': return csi('D', mods);
    case 'Home': return csi('H', mods);
    case 'End': return csi('F', mods);
    case 'Insert': return csiTilde(2, mods);
    case 'Delete': return csiTilde(3, mods);
    case 'PageUp': return csiTilde(5, mods);
    case 'PageDown': return csiTilde(6, mods);
    case 'Shift': case 'Control': case 'Alt': case 'Meta': case 'CapsLock': case 'Dead': return null;
    default: break;
  }

  const fn = FUNCTION_KEYS[key];
  if (fn !== undefined) return csiTilde(fn, mods);

  // A single character is text. Control folds it into C0; alt prefixes ESC.
  if (key.length === 1) {
    if (mods.ctrl) {
      const upper = key.toUpperCase();
      const at = upper.charCodeAt(0);
      if (at >= 64 && at <= 95) return String.fromCharCode(at - 64);
      if (key === ' ') return '\x00';
      if (key === '[') return '\x1b';
      if (key === '\\') return '\x1c';
      if (key === ']') return '\x1d';
      if (key === '^') return '\x1e';
      if (key === '_') return '\x1f';
      return null;
    }
    return mods.alt ? `\x1b${key}` : key;
  }

  // Fall back to the physical key for anything else printable.
  if (code && code.startsWith('Key') && code.length === 4) {
    const ch = mods.shift ? code[3] : code[3].toLowerCase();
    return mods.alt ? `\x1b${ch}` : ch;
  }
  return null;
}

// ── Mouse reporting ──────────────────────────────────────────────────────

/**
 * Track whether the running program asked for mouse reports.
 *
 * libghostty-vt's snapshot exposes no mouse-mode flag, so the modes are read
 * from the terminal's own output: the last DEC private mode set for 1000/1002/
 * 1003 decides. A program that never asked gets no synthetic mouse events.
 */
export function scanMouseMode(current: boolean, text: string): boolean {
  const re = /\x1b\[\?(1000|1002|1003)([hl])/g;
  let mode = current;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) mode = match[2] === 'h';
  return mode;
}

/** An SGR mouse report (1006 mode), the encoding every modern TUI understands. */
export function encodeMouse(
  kind: 'down' | 'up' | 'move' | 'wheel',
  button: number,
  col: number,
  row: number,
  mods: KeyModifiers = {},
  deltaY = 0,
): string {
  let code: number;
  if (kind === 'wheel') code = deltaY < 0 ? 64 : 65;
  else {
    code = button & 7;
    if (kind === 'move') code += 32;
  }
  if (mods.shift) code += 4;
  if (mods.meta) code += 8;
  if (mods.ctrl) code += 16;
  const final = kind === 'up' ? 'm' : 'M';
  return `\x1b[<${code};${col + 1};${row + 1}${final}`;
}

// ── The view ─────────────────────────────────────────────────────────────

interface InputPayload {
  type?: string;
  key?: string;
  code?: string;
  modifiers?: KeyModifiers;
  x?: number;
  y?: number;
  button?: number;
  deltaY?: number;
  pasteText?: string;
  width?: number;
  height?: number;
}

/** The widgets that belong to one tab, so a close can destroy exactly those. */
interface TabWidgets { buttonId: AbjectId; closeId: AbjectId }

/** What a session is doing, from this view's point of view. */
export interface TerminalViewTab {
  tabId: string;
  name: string;
  sessionId: string;
  active: boolean;
  renamed: boolean;
}

export class TerminalView extends Abject {
  private widgetManagerId?: AbjectId;
  private terminalId?: AbjectId;
  private clipboardId?: AbjectId;
  private uiTheme?: ThemeData;

  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private stripLayoutId?: AbjectId;
  private renameRowId?: AbjectId;
  private canvasId?: AbjectId;

  private newTabBtnId?: AbjectId;
  private renameBtnId?: AbjectId;
  private renameInputId?: AbjectId;
  private renameSaveBtnId?: AbjectId;
  private renameCancelBtnId?: AbjectId;

  /** The tabs, as the model keeps them. */
  private tabs: TabSetState = emptyTabSet();
  /** Each tab's own strip widgets, so one close touches one tab. */
  private tabWidgets = new Map<string, TabWidgets>();
  /** The last screen each session reported, kept so a switch repaints instantly. */
  private screens = new Map<string, TerminalScreen>();
  /** The emulator revision drawn per tab, so an unchanged session costs no draw. */
  private revisions = new Map<string, number>();
  /** Mouse-mode tracking is per session: each program asks for itself. */
  private mouse = new Map<string, { tracking: boolean; offset: number }>();

  private shellCwd?: string;

  private canvasW = 0;
  private canvasH = 0;
  private cols = 80;
  private rows = 24;

  /** Inclusive cell-coordinate selection of the shown tab, and drag state. */
  private selection?: { fromCol: number; fromRow: number; toCol: number; toRow: number };
  private dragging = false;
  /** Where the current mouse-down landed, in cells: the anchor of a drag. */
  private dragAnchor?: { col: number; row: number };

  private repaintTimer?: ReturnType<typeof setTimeout>;
  private drawInFlight = false;
  private drawQueued = false;

  constructor() {
    super({
      manifest: {
        name: 'TerminalView',
        description: 'A terminal window with tabs: several approved shells at once, each in its own tab, painted from libghostty cells and typed into through one canvas.',
        version: '2.0.0',
        interface: {
          id: TERMINAL_VIEW_INTERFACE,
          name: 'TerminalView',
          description: 'Opens a tabbed terminal window on approved shells. The window holds no shell capability of its own.',
          methods: [
            {
              name: 'show',
              description: 'Open the terminal window and its first shell (asks permission through Terminal).',
              parameters: [
                { name: 'cwd', type: { kind: 'primitive', primitive: 'string' }, description: 'Working directory to scope the shells to. Defaults to the home directory.', optional: true },
              ],
              returns: { kind: 'primitive', primitive: 'boolean' },
            },
            { name: 'hide', description: 'Close every shell and destroy the window.', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            {
              name: 'newTab',
              description: 'Open another shell in a new tab and show it (asks permission through Terminal).',
              parameters: [
                { name: 'cwd', type: { kind: 'primitive', primitive: 'string' }, description: 'Working directory for this shell. Defaults to the window\u2019s.', optional: true },
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'A name for the tab instead of the default', optional: true },
              ],
              returns: { kind: 'object', properties: {} },
            },
            {
              name: 'closeTab',
              description: 'Close one tab\u2019s shell and remove that tab. Closing the last tab closes the window.',
              parameters: [{ name: 'tabId', type: { kind: 'primitive', primitive: 'string' }, description: 'Tab id from tabs()' }],
              returns: { kind: 'object', properties: {} },
            },
            {
              name: 'selectTab',
              description: 'Show one tab\u2019s screen; the others keep running.',
              parameters: [{ name: 'tabId', type: { kind: 'primitive', primitive: 'string' }, description: 'Tab id from tabs()' }],
              returns: { kind: 'object', properties: {} },
            },
            {
              name: 'renameTab',
              description: 'Name a tab. The name lasts for as long as the tab does.',
              parameters: [
                { name: 'tabId', type: { kind: 'primitive', primitive: 'string' }, description: 'Tab id from tabs(); the active tab when omitted', optional: true },
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'The new name' },
              ],
              returns: { kind: 'object', properties: {} },
            },
            { name: 'tabs', description: 'The open tabs, their names, their ids and which one is showing.', parameters: [], returns: { kind: 'object', properties: {} } },
            { name: 'getState', description: 'What the window is showing: tabs, active tab, grid size, cursor.', parameters: [], returns: { kind: 'reference', reference: 'TerminalViewState' } },
            { name: 'input', description: 'Keyboard, mouse and paste events forwarded from the canvas.', parameters: [{ name: 'type', type: { kind: 'primitive', primitive: 'string' }, description: 'keydown | mousedown | mouseup | mousemove | wheel | paste | canvasResize' }] },
          ],
        },
        tags: ['ui', 'terminal'],
      },
    });
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('show', async (msg: AbjectMessage) => {
      const { cwd } = (msg.payload ?? {}) as { cwd?: string };
      return this.show(cwd);
    });
    this.on('hide', async () => this.hide());
    this.on('windowCloseRequested', async () => { await this.hide(); });
    this.on('getState', async () => this.getState());
    this.on('input', async (msg: AbjectMessage) => { await this.onInput(msg); });

    this.on('newTab', async (msg: AbjectMessage) => {
      const { cwd, name } = (msg.payload ?? {}) as { cwd?: string; name?: string };
      return this.newTab(cwd, name);
    });
    this.on('closeTab', async (msg: AbjectMessage) => {
      const { tabId } = (msg.payload ?? {}) as { tabId?: string };
      return this.closeTab(tabId);
    });
    this.on('selectTab', async (msg: AbjectMessage) => {
      const { tabId } = (msg.payload ?? {}) as { tabId?: string };
      return this.selectTab(tabId);
    });
    this.on('renameTab', async (msg: AbjectMessage) => {
      const { tabId, name } = (msg.payload ?? {}) as { tabId?: string; name?: string };
      return this.renameTab(name, tabId);
    });
    this.on('tabs', async () => this.tabSnapshot());

    // Chrome events: which widget fired, and what it did.
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = (msg.payload ?? {}) as { aspect?: string; value?: unknown };
      await this.onWidgetEvent(msg.routing.from, aspect ?? '', value);
    });

    // Session events carry the session they came from, because several are open.
    this.on('output', async (msg: AbjectMessage) => {
      const { sessionId } = (msg.payload ?? {}) as { sessionId?: string };
      if (sessionId && sessionId === this.activeSessionId) this.scheduleRepaint();
    });
    this.on('exit', async () => { this.scheduleRepaint(); });
  }

  protected override async onInit(): Promise<void> {
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    this.terminalId = await this.discoverDep('Terminal') ?? undefined;
    this.clipboardId = await this.discoverDep('Clipboard') ?? undefined;
    try { this.uiTheme = await this.fetchTheme(); } catch { this.uiTheme = undefined; }
  }

  // ── Which tab is showing ──

  /** The session the canvas is showing, if any. */
  private get activeSessionId(): AbjectId | undefined {
    const tab = activeTab(this.tabs);
    return tab ? (tab.sessionId as AbjectId) : undefined;
  }

  private tabSnapshot(): { tabs: TerminalViewTab[]; activeTabId: string | null; open: boolean } {
    return {
      tabs: this.tabs.tabs.map(tab => ({
        tabId: tab.id,
        name: tab.name,
        sessionId: tab.sessionId,
        active: tab.id === this.tabs.activeId,
        renamed: tab.renamed,
      })),
      activeTabId: this.tabs.activeId,
      open: !!this.windowId,
    };
  }

  // ── Window lifecycle ──

  async show(cwd?: string): Promise<boolean> {
    if (this.windowId) return true;
    if (cwd) this.shellCwd = cwd;

    if (!this.widgetManagerId) this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    if (!this.terminalId) this.terminalId = await this.discoverDep('Terminal') ?? undefined;
    require(!!this.widgetManagerId, 'TerminalView needs WidgetManager: there is no display to draw on');
    require(!!this.terminalId, 'TerminalView needs the Terminal capability: no object here can start a shell');

    const display = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId, 'getDisplayInfo', {}),
    );
    const x = Math.max(20, Math.floor((display.width - WIN_W) / 2));
    const y = Math.max(20, Math.floor((display.height - WIN_H) / 2));

    const windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId, 'createWindowAbject', {
        title: 'Terminal',
        rect: { x, y, width: WIN_W, height: WIN_H },
        zIndex: 150,
        resizable: true,
      }),
    );
    this.windowId = windowId;

    try {
      await this.buildChrome(windowId);
      // The first tab is the one step that asks the person anything: the shell
      // approval. A refusal must not leave an empty window behind.
      const opened = await this.newTab(this.shellCwd);
      if (!opened.success) throw new Error(opened.error ?? 'the first terminal tab could not be opened');
    } catch (err) {
      log.warn('could not open a terminal window', err);
      await this.teardownWindow();
      throw err;
    }

    this.changed('visibility', true);
    this.checkInvariants();
    return true;
  }

  /**
   * Build everything that outlives a tab: the root column, the strip, the
   * rename row (collapsed until asked for) and the canvas.
   */
  private async buildChrome(windowId: AbjectId): Promise<void> {
    const wm = this.widgetManagerId!;
    const theme = this.uiTheme;

    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, wm, 'createVBox', {
        windowId,
        margins: { top: 6, right: 6, bottom: 6, left: 6 },
        spacing: 6,
      }),
    );

    // The strip: a named band across the window, one cell per open tab.
    this.stripLayoutId = await this.request<AbjectId>(
      request(this.id, wm, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 4, right: 6, bottom: 4, left: 6 },
        spacing: 4,
        style: { background: theme?.windowBg ?? '#13141f', radius: 6 },
      }),
    );
    await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
      widgetId: this.stripLayoutId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: STRIP_H },
    }));

    // The rename row: hidden outright until the person asks to rename. A
    // zero-height slot is not hidden — the row's own children keep their
    // preferred height, so their borders still painted and peeked out from
    // under the strip. A hidden widget takes no room in its parent AND draws
    // nothing, and the row's children never run because the row never renders.
    this.renameRowId = await this.request<AbjectId>(
      request(this.id, wm, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 6, bottom: 0, left: 6 },
        spacing: 4,
      }),
    );
    await this.setRenameRowShown(false);

    const created = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, wm, 'create', {
        specs: [
          { type: 'button', windowId, text: '+ New tab', style: { fontSize: 12 } },
          { type: 'button', windowId, text: 'Rename', style: { fontSize: 12 } },
          { type: 'textInput', windowId, placeholder: 'Tab name', value: '' },
          { type: 'button', windowId, text: 'Save', style: { fontSize: 12 } },
          { type: 'button', windowId, text: 'Cancel', style: { fontSize: 12 } },
        ],
      }),
    );
    const ids = created.widgetIds;
    [this.newTabBtnId, this.renameBtnId, this.renameInputId, this.renameSaveBtnId, this.renameCancelBtnId] = ids;

    await this.request(request(this.id, this.renameRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.renameInputId, sizePolicy: { horizontal: 'expanding', vertical: 'fixed' }, preferredSize: { height: 28 } },
        { widgetId: this.renameSaveBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 60, height: 28 } },
        { widgetId: this.renameCancelBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 70, height: 28 } },
      ],
    }));

    // The grid itself. Input comes back to this object, tagged with the canvas id.
    this.canvasId = await this.request<AbjectId>(
      request(this.id, wm, 'createCanvas', { windowId, inputTargetId: this.id }),
    );
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.canvasId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    const size = await this.request<{ width: number; height: number }>(
      request(this.id, this.canvasId, 'getCanvasSize', {}),
    );
    this.applyCanvasSize(size.width, size.height);

    for (const id of [this.newTabBtnId, this.renameBtnId, this.renameInputId, this.renameSaveBtnId, this.renameCancelBtnId]) {
      if (id) await this.request(request(this.id, id, 'addDependent', {}));
    }
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;
    await this.teardownWindow();
    this.changed('visibility', false);
    this.checkInvariants();
    return true;
  }

  /**
   * Close every shell and destroy the window.
   *
   * The approvals were for this window, so a close request ends all of them:
   * each session is closed through the capability that keeps the map, then the
   * window goes through WidgetManager, which is the only thing that makes it
   * disappear.
   */
  private async teardownWindow(): Promise<void> {
    const windowId = this.windowId;
    const sessions = this.tabs.tabs.map(tab => tab.sessionId as AbjectId);

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.stripLayoutId = undefined;
    this.renameRowId = undefined;
    this.canvasId = undefined;
    this.newTabBtnId = undefined;
    this.renameBtnId = undefined;
    this.renameInputId = undefined;
    this.renameSaveBtnId = undefined;
    this.renameCancelBtnId = undefined;
    this.tabs = emptyTabSet();
    this.tabWidgets.clear();
    this.screens.clear();
    this.revisions.clear();
    this.mouse.clear();
    this.selection = undefined;
    this.dragging = false;
    this.dragAnchor = undefined;
    this.canvasW = 0;
    this.canvasH = 0;
    this.cancelRepaint();

    if (this.terminalId) {
      for (const sessionId of sessions) {
        try { await this.request(request(this.id, this.terminalId, 'close', { sessionId })); }
        catch (err) { log.warn('could not close a terminal session', err); }
      }
    }
    if (windowId && this.widgetManagerId) {
      try { await this.request(request(this.id, this.widgetManagerId, 'destroyWindowAbject', { windowId })); }
      catch (err) { log.warn('could not destroy the terminal window', err); }
    }
  }

  async getState(): Promise<Record<string, unknown>> {
    const tab = activeTab(this.tabs);
    const screen = tab ? this.screens.get(tab.sessionId) : undefined;
    return {
      visible: !!this.windowId,
      tabs: this.tabSnapshot().tabs,
      activeTabId: this.tabs.activeId,
      tabCount: this.tabs.tabs.length,
      sessionId: tab?.sessionId,
      cols: this.cols,
      rows: this.rows,
      canvas: { width: this.canvasW, height: this.canvasH },
      title: screen?.title,
      cursor: screen?.cursor ?? null,
      mouseTracking: this.mouseTrackingFor(tab?.sessionId),
      hasSelection: !!this.selection,
      exitCode: screen?.exitCode,
      seq: screen?.seq,
    };
  }

  // ── Tabs ──

  /**
   * Open another shell in a new tab and show it.
   *
   * The session is opened first, because that is the step that asks the person
   * (directory, then the session-wide shell approval); the strip is only added
   * to once a session really exists.
   */
  async newTab(cwd?: string, name?: string): Promise<{ success: boolean; tabId?: string; sessionId?: string; name?: string; error?: string }> {
    if (!this.windowId) return { success: false, error: 'the terminal window is not open' };
    if (this.tabs.tabs.length >= MAX_TABS) {
      return { success: false, error: `a terminal window holds at most ${MAX_TABS} tabs` };
    }
    if (!this.terminalId) this.terminalId = await this.discoverDep('Terminal') ?? undefined;
    if (!this.terminalId) return { success: false, error: 'no Terminal capability to open a shell' };

    let opened: { sessionId: AbjectId; cwd?: string; cols?: number; rows?: number };
    try {
      opened = await this.request<{ sessionId: AbjectId }>(
        request(this.id, this.terminalId, 'open', {
          cwd: cwd ?? this.shellCwd,
          cols: this.cols,
          rows: this.rows,
        }),
        PERMISSION_WAIT_MS,
      );
    } catch (err) {
      log.info('a terminal tab was not approved', err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const sessionId = opened.sessionId;
    const added = addTab(this.tabs, sessionId, { name });
    this.tabs = added.state;
    tabSetInvariants(this.tabs);

    try {
      await this.request(request(this.id, sessionId, 'addDependent', {}));
      await this.createTabWidgets(added.tab);
      await this.rebuildStrip();
      await this.activateTab(added.tab.id);
    } catch (err) {
      log.warn('could not build a tab for the new session', err);
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    return { success: true, tabId: added.tab.id, sessionId, name: added.tab.name };
  }

  /** The two widgets a tab owns in the strip. */
  private async createTabWidgets(tab: TerminalTab): Promise<void> {
    if (!this.windowId || !this.widgetManagerId) return;
    const created = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId, 'create', {
        specs: [
          { type: 'button', windowId: this.windowId, text: tab.name, style: { fontSize: 12 } },
          { type: 'button', windowId: this.windowId, text: '×', style: { fontSize: 14 } },
        ],
      }),
    );
    const [buttonId, closeId] = created.widgetIds;
    this.tabWidgets.set(tab.id, { buttonId, closeId });
    await this.request(request(this.id, buttonId, 'addDependent', {}));
    await this.request(request(this.id, closeId, 'addDependent', {}));
  }

  /**
   * Lay the strip out again: every tab in order, then the two window-level
   * actions pinned to the right by the expanding tabs.
   *
   * Composed layouts only append, so the strip is laid out from scratch each
   * time the set of tabs changes; the widgets are kept, not recreated.
   */
  private async rebuildStrip(): Promise<void> {
    const stripId = this.stripLayoutId;
    if (!stripId) return;

    await this.request(request(this.id, stripId, 'clearLayoutChildren', { keep: true }));

    const children: Array<{ widgetId: AbjectId; sizePolicy: Record<string, string>; preferredSize: Record<string, number> }> = [];
    for (const tab of this.tabs.tabs) {
      const widgets = this.tabWidgets.get(tab.id);
      if (!widgets) continue;
      children.push({
        widgetId: widgets.buttonId,
        sizePolicy: { horizontal: 'expanding', vertical: 'fixed' },
        preferredSize: { width: 96, height: TAB_H },
      });
      children.push({
        widgetId: widgets.closeId,
        sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
        preferredSize: { width: 22, height: TAB_H },
      });
    }
    if (this.newTabBtnId) {
      children.push({ widgetId: this.newTabBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 96, height: TAB_H } });
    }
    if (this.renameBtnId) {
      children.push({ widgetId: this.renameBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: 76, height: TAB_H } });
    }
    if (children.length > 0) {
      await this.request(request(this.id, stripId, 'addLayoutChildren', { children }));
    }
    await this.refreshStripLabels();
  }

  /**
   * Say each tab's name, cut to the room the strip has, and style the shown
   * tab so the strip reads as one selected tab among several.
   */
  private async refreshStripLabels(): Promise<void> {
    const theme = this.uiTheme;
    const stripWidth = this.canvasW > 0 ? this.canvasW + 12 : WIN_W;
    const budget = labelBudget(stripWidth, this.tabs.tabs.length);
    for (const tab of this.tabs.tabs) {
      const widgets = this.tabWidgets.get(tab.id);
      if (!widgets) continue;
      const active = tab.id === this.tabs.activeId;
      await this.request(request(this.id, widgets.buttonId, 'update', {
        text: tabLabel(tab.name, budget),
        style: {
          fontSize: 12,
          color: active ? (theme?.canvasBg ?? '#101014') : (theme?.textSecondary ?? '#9a98a8'),
          background: active ? (theme?.accent ?? '#5be5a0') : (theme?.buttonBg ?? '#1f2030'),
          radius: 4,
        },
      }));
      await this.request(request(this.id, widgets.closeId, 'update', {
        style: {
          fontSize: 14,
          color: active ? (theme?.canvasBg ?? '#101014') : (theme?.textSecondary ?? '#9a98a8'),
          background: active ? (theme?.accent ?? '#5be5a0') : (theme?.buttonBg ?? '#1f2030'),
          radius: 4,
        },
      }));
    }
    if (this.windowId) {
      const tab = activeTab(this.tabs);
      const title = tab ? `Terminal — ${tab.name}` : 'Terminal';
      this.send(request(this.id, this.windowId, 'setTitle', { title }));
    }
  }

  /** Show one tab: resize its shell to the grid, then repaint from its screen. */
  private async activateTab(tabId: string): Promise<void> {
    const tab = findTab(this.tabs, tabId);
    if (!tab) return;
    this.tabs = selectTab(this.tabs, tabId);
    this.selection = undefined;
    this.dragging = false;

    // Each shell may have been sized for a different grid; the canvas is one.
    const sessionId = tab.sessionId as AbjectId;
    try {
      await this.request(request(this.id, sessionId, 'resize', { cols: this.cols, rows: this.rows }));
    } catch (err) { log.info('could not size the newly shown shell', err); }

    await this.refreshStripLabels();
    this.revisions.delete(tab.sessionId);
    await this.refreshFrame(true);
    this.changed('activeTab', { tabId: tab.id, sessionId: tab.sessionId });
  }

  async selectTab(tabId: string | undefined): Promise<{ success: boolean; error?: string; activeTabId?: string | null }> {
    if (!this.windowId) return { success: false, error: 'the terminal window is not open' };
    const tab = findTab(this.tabs, tabId);
    if (!tab) return { success: false, error: 'no such tab' };
    await this.activateTab(tab.id);
    return { success: true, activeTabId: this.tabs.activeId };
  }

  /**
   * Close one tab's shell, leaving the others running.
   *
   * A tab that is not showing closes silently; the shown one hands the canvas to
   * its neighbour, and the last tab closing takes the window down with it.
   */
  async closeTab(tabId: string | undefined): Promise<{ success: boolean; error?: string; closedWindow?: boolean; activeTabId?: string | null }> {
    const tab = findTab(this.tabs, tabId);
    if (!tab) return { success: false, error: 'no such tab' };

    const sessionId = tab.sessionId as AbjectId;
    if (this.terminalId) {
      try { await this.request(request(this.id, this.terminalId, 'close', { sessionId })); }
      catch (err) { log.warn('could not close the tab\u2019s shell', err); }
    }

    const removed = removeTab(this.tabs, tab.id);
    this.tabs = removed.state;
    tabSetInvariants(this.tabs);
    this.screens.delete(tab.sessionId);
    this.revisions.delete(tab.sessionId);
    this.mouse.delete(tab.sessionId);

    const widgets = this.tabWidgets.get(tab.id);
    this.tabWidgets.delete(tab.id);
    for (const id of widgets ? [widgets.buttonId, widgets.closeId] : []) {
      try { await this.request(request(this.id, id, 'destroy', {})); }
      catch (err) { log.info('could not destroy a closed tab\u2019s widgets', err); }
    }

    // The last tab closing ends the window: the approvals were for this window.
    if (this.tabs.tabs.length === 0) {
      await this.hide();
      return { success: true, closedWindow: true, activeTabId: null };
    }

    await this.rebuildStrip();
    if (removed.wasActive && this.tabs.activeId) await this.activateTab(this.tabs.activeId);
    else await this.refreshStripLabels();

    this.changed('tabs', this.tabSnapshot());
    return { success: true, activeTabId: this.tabs.activeId };
  }

  /**
   * Name a tab.
   *
   * The name is the tab's for as long as it lives: the strip shows it, nothing
   * recomputes a default, and it survives switching and hiding behind another.
   */
  async renameTab(name: string | undefined, tabId?: string): Promise<{ success: boolean; error?: string; tabId?: string; name?: string }> {
    const target = tabId ?? this.tabs.activeId;
    const tab = findTab(this.tabs, target);
    if (!tab) return { success: false, error: 'no tab to rename' };
    if (typeof name !== 'string' || name.trim().length === 0) {
      return { success: false, error: 'a tab keeps a name: an empty name is refused' };
    }
    try {
      this.tabs = renameTabInSet(this.tabs, tab.id, name);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    tabSetInvariants(this.tabs);
    await this.refreshStripLabels();
    this.changed('tabs', this.tabSnapshot());
    return { success: true, tabId: tab.id, name: findTab(this.tabs, tab.id)?.name };
  }

  /** Reveal the rename row with the shown tab's name in it. */
  private async openRenameRow(): Promise<void> {
    const tab = activeTab(this.tabs);
    if (!tab || !this.renameRowId || !this.rootLayoutId) return;
    await this.request(request(this.id, this.renameInputId!, 'update', { value: tab.name }));
    await this.setRenameRowShown(true);
  }

  private async closeRenameRow(): Promise<void> {
    await this.setRenameRowShown(false);
  }

  /**
   * Show or hide the whole rename row.
   *
   * Hiding is the only thing that makes the row contribute nothing: a fixed
   * zero-height slot still leaves the row's children at their own preferred
   * height and still draws them, which is the sliver that showed beneath the
   * strip's right-hand buttons. A hidden widget takes no room in the parent's
   * flow (no height, no spacing) and draws no commands, so the canvas gets the
   * space back and the strip and canvas stay where they belong.
   */
  private async setRenameRowShown(shown: boolean): Promise<void> {
    if (!this.renameRowId || !this.rootLayoutId) return;
    // Hide before resizing on the way out and show only after resizing on the
    // way in, so no frame ever paints a half-laid-out row.
    if (!shown) await this.request(request(this.id, this.renameRowId, 'update', { visible: false }));
    await this.request(request(this.id, this.rootLayoutId, 'updateLayoutChild', {
      widgetId: this.renameRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: shown ? RENAME_H : 0 },
    }));
    if (shown) await this.request(request(this.id, this.renameRowId, 'update', { visible: true }));
  }

  /** Read the name field and commit it to the shown tab. */
  private async commitRename(): Promise<void> {
    if (!this.renameInputId) return;
    let text = '';
    try { text = await this.request<string>(request(this.id, this.renameInputId, 'getValue', {})); }
    catch (err) { log.info('could not read the rename field', err); }
    if (typeof text !== 'string' || text.trim().length === 0) { await this.closeRenameRow(); return; }
    await this.renameTab(text);
    await this.closeRenameRow();
  }

  /** Which tab a strip widget belongs to, or undefined for the window's own buttons. */
  private tabForWidget(widgetId: AbjectId): { tabId?: string; kind: 'tab' | 'close' | 'other' } {
    for (const [tabId, widgets] of this.tabWidgets) {
      if (widgets.buttonId === widgetId) return { tabId, kind: 'tab' };
      if (widgets.closeId === widgetId) return { tabId, kind: 'close' };
    }
    return { kind: 'other' };
  }

  /** All chrome events land here: a tab, its close button, or a window action. */
  private async onWidgetEvent(fromId: AbjectId, aspect: string, _value: unknown): Promise<void> {
    if (aspect === 'submit') { if (fromId === this.renameInputId) await this.commitRename(); return; }
    if (aspect !== 'click') return;

    if (fromId === this.newTabBtnId) { await this.newTab(this.shellCwd); return; }
    if (fromId === this.renameBtnId) { await this.openRenameRow(); return; }
    if (fromId === this.renameSaveBtnId) { await this.commitRename(); return; }
    if (fromId === this.renameCancelBtnId) { await this.closeRenameRow(); return; }

    const where = this.tabForWidget(fromId);
    if (where.kind === 'tab' && where.tabId) {
      if (where.tabId === this.tabs.activeId) return;
      await this.selectTab(where.tabId);
      return;
    }
    if (where.kind === 'close' && where.tabId) { await this.closeTab(where.tabId); }
  }

  // ── Frame feed ──

  private scheduleRepaint(): void {
    if (this.repaintTimer) return;
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = undefined;
      void this.onOutputFrame();
    }, REPAINT_MS);
  }

  private cancelRepaint(): void {
    if (!this.repaintTimer) return;
    clearTimeout(this.repaintTimer);
    this.repaintTimer = undefined;
  }

  private async onOutputFrame(): Promise<void> {
    await this.refreshMouseMode();
    await this.refreshFrame(false);
  }

  private mouseTrackingFor(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    return this.mouse.get(sessionId)?.tracking ?? false;
  }

  /**
   * Read the shown session's screen and, when it really changed, repaint it.
   *
   * `revision` is the emulator's own output counter: it moves only when that
   * terminal's content moved, so an idle tab costs one message and no draw.
   */
  private async refreshFrame(force: boolean): Promise<void> {
    const tab = activeTab(this.tabs);
    if (!tab || !this.canvasId) return;
    let screen: TerminalScreen;
    try {
      screen = await this.request<TerminalScreen>(
        request(this.id, tab.sessionId as AbjectId, 'screen', {}),
      );
    } catch (err) { log.info('could not read the shown screen', err); return; }

    const known = this.revisions.get(tab.sessionId);
    if (!force && screen.revision !== undefined && screen.revision === known) return;
    if (screen.revision !== undefined) this.revisions.set(tab.sessionId, screen.revision);

    // Only the shown screen is kept for painting, so a switch never paints one
    // tab's cells into the other's frame.
    this.screens.clear();
    this.screens.set(tab.sessionId, screen);
    this.draw();
  }

  private draw(): void {
    if (!this.canvasId) return;
    if (this.drawInFlight) { this.drawQueued = true; return; }
    this.drawInFlight = true;
    void this.flushDraw();
  }

  private async flushDraw(): Promise<void> {
    try {
      do {
        this.drawQueued = false;
        const canvasId = this.canvasId;
        if (!canvasId) break;
        const tab = activeTab(this.tabs);
        const screen = tab ? this.screens.get(tab.sessionId) : undefined;
        const theme = this.uiTheme;
        const commands = composeTerminalFrame(screen, {
          cellW: CELL_W,
          cellH: CELL_H,
          fontSize: FONT_SIZE,
          fontFamily: fontStacks(theme).mono,
          defaultFg: theme?.textPrimary ?? '#e6e6e6',
          defaultBg: theme?.canvasBg ?? '#101014',
          selection: this.selection,
          selectionColor: theme ? `${theme.accent}55` : undefined,
        });
        try { await this.request(request(this.id, canvasId, 'draw', { commands })); }
        catch (err) { log.warn('terminal frame draw failed', err); break; }
      } while (this.drawQueued);
    } finally {
      this.drawInFlight = false;
    }
  }

  // ── Input ──

  private async onInput(msg: AbjectMessage): Promise<void> {
    const payload = (msg.payload ?? {}) as InputPayload;
    const type = payload.type;

    if (type === 'canvasResize') {
      this.applyCanvasSize(payload.width ?? 0, payload.height ?? 0);
      await this.onCanvasResize();
      return;
    }
    if (!this.activeSessionId) return;

    switch (type) {
      case 'keydown': await this.onKey(payload); return;
      case 'paste': await this.onPaste(payload); return;
      case 'mousedown': case 'mousemove': case 'mouseup': case 'wheel':
        await this.onMouse(payload); return;
      default: return;
    }
  }

  private async onKey(payload: InputPayload): Promise<void> {
    const mods = payload.modifiers ?? {};
    const key = payload.key ?? '';

    // The clipboard shortcuts are the view's, not the program's: both go
    // through the Clipboard capability, which asks the person. Ctrl+Shift+T
    // opens a tab and Ctrl+Shift+W closes the shown one, as a terminal window
    // does elsewhere.
    if (mods.ctrl && mods.shift && (key === 'V' || key === 'v')) { await this.pasteFromClipboard(); return; }
    if (mods.ctrl && mods.shift && (key === 'C' || key === 'c')) { await this.copySelection(); return; }
    if (mods.ctrl && mods.shift && (key === 'T' || key === 't')) { await this.newTab(this.shellCwd); return; }
    if (mods.ctrl && mods.shift && (key === 'W' || key === 'w')) { await this.closeTab(this.tabs.activeId ?? undefined); return; }

    const bytes = encodeKey(payload.key, payload.code, mods);
    if (bytes === null || bytes.length === 0) return;
    await this.type(bytes);
  }

  private async type(text: string): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    try { await this.request(request(this.id, sessionId, 'write', { text })); }
    catch (err) { log.warn('typing into the terminal failed', err); }
  }

  private async onPaste(payload: InputPayload): Promise<void> {
    const text = payload.pasteText;
    if (typeof text === 'string' && text.length > 0) { await this.pasteText(text); return; }
    await this.pasteFromClipboard();
  }

  private async pasteText(text: string): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    try { await this.request(request(this.id, sessionId, 'paste', { text })); }
    catch (err) { log.warn('paste into the terminal failed', err); }
  }

  /**
   * Read the clipboard and paste it.
   *
   * The read is the Clipboard capability's, so PermissionBroker is asked with
   * type 'clipboard' — a terminal program cannot reach the person's clipboard
   * through this view without that answer.
   */
  private async pasteFromClipboard(): Promise<void> {
    if (!this.clipboardId) this.clipboardId = await this.discoverDep('Clipboard') ?? undefined;
    if (!this.clipboardId) { log.warn('no Clipboard capability to paste from'); return; }
    try {
      const reply = await this.request<{ text?: string }>(request(this.id, this.clipboardId, 'read', {}));
      if (typeof reply.text === 'string' && reply.text.length > 0) await this.pasteText(reply.text);
    } catch (err) {
      log.info('clipboard read was not granted', err);
    }
  }

  /** Copy the current selection, asking PermissionBroker through Clipboard. */
  private async copySelection(): Promise<void> {
    const text = this.selectionText();
    if (text.length === 0) return;
    if (!this.clipboardId) this.clipboardId = await this.discoverDep('Clipboard') ?? undefined;
    if (!this.clipboardId) { log.warn('no Clipboard capability to copy to'); return; }
    try { await this.request(request(this.id, this.clipboardId, 'write', { text })); }
    catch (err) { log.info('clipboard write was not granted', err); }
  }

  private selectionText(): string {
    const tab = activeTab(this.tabs);
    const screen = tab ? this.screens.get(tab.sessionId) : undefined;
    const sel = this.selection;
    if (!screen || !sel) return '';

    const forward = sel.fromRow < sel.toRow || (sel.fromRow === sel.toRow && sel.fromCol <= sel.toCol);
    const top = forward ? sel.fromRow : sel.toRow;
    const bottom = forward ? sel.toRow : sel.fromRow;
    const topCol = forward ? sel.fromCol : sel.toCol;
    const bottomCol = forward ? sel.toCol : sel.fromCol;

    const lines: string[] = [];
    for (let r = top; r <= bottom && r < screen.screen.length; r += 1) {
      const cells = screen.screen[r]?.cells ?? [];
      const startCol = r === top ? topCol : 0;
      const endCol = r === bottom ? bottomCol : screen.cols;
      let line = '';
      let col = 0;
      for (const cell of cells) {
        if (col >= endCol) break;
        if (col >= startCol && !cell.hidden) line += cell.text;
        col += cell.width;
      }
      lines.push(line);
    }
    return lines.join('\n').replace(/\s+$/, '');
  }

  private async onMouse(payload: InputPayload): Promise<void> {
    const col = Math.max(0, Math.min(this.cols - 1, Math.floor((payload.x ?? 0) / CELL_W)));
    const row = Math.max(0, Math.min(this.rows - 1, Math.floor((payload.y ?? 0) / CELL_H)));
    const mods = payload.modifiers ?? {};
    const button = payload.button ?? 0;
    const tracking = this.mouseTrackingFor(activeTab(this.tabs)?.sessionId);

    if (payload.type === 'wheel') {
      if (tracking) await this.type(encodeMouse('wheel', 0, col, row, mods, payload.deltaY ?? 0));
      else await this.scroll((payload.deltaY ?? 0) > 0 ? 3 : -3);
      return;
    }

    if (tracking) {
      const kind = payload.type === 'mousedown' ? 'down' : payload.type === 'mouseup' ? 'up' : 'move';
      await this.type(encodeMouse(kind, button, col, row, mods));
      return;
    }

    // No program asked for the mouse, so a DRAG selects text. A plain click is
    // not a selection: it clears one, and a selection only appears once the
    // pointer has moved to another cell from where the button went down —
    // otherwise every click left a highlight on the terminal and the window
    // read as permanently in select mode.
    if (payload.type === 'mousedown') {
      this.dragging = true;
      this.dragAnchor = { col, row };
      if (this.selection) {
        this.selection = undefined;
        this.draw();
      }
      return;
    }
    if (payload.type === 'mousemove' && this.dragging) {
      const from = this.dragAnchor;
      if (!from) return;
      if (!this.selection && from.col === col && from.row === row) return;
      this.selection = { fromCol: from.col, fromRow: from.row, toCol: col, toRow: row };
      this.draw();
      return;
    }
    if (payload.type === 'mouseup' && this.dragging) {
      this.dragging = false;
      this.dragAnchor = undefined;
      if (this.selection) {
        this.selection = { ...this.selection, toCol: col, toRow: row };
        this.draw();
      }
    }
  }

  private async scroll(delta: number): Promise<void> {
    const sessionId = this.activeSessionId;
    if (!sessionId) return;
    try {
      await this.request(request(this.id, sessionId, 'scroll', { delta }));
      const tab = activeTab(this.tabs);
      if (tab) this.revisions.delete(tab.sessionId);
      await this.refreshFrame(true);
    } catch (err) { log.warn('scrolling the terminal failed', err); }
  }

  // ── Grid ──

  private applyCanvasSize(width: number, height: number): void {
    if (width > 0) this.canvasW = width;
    if (height > 0) this.canvasH = height;
    if (this.canvasW <= 0 || this.canvasH <= 0) return;
    this.cols = Math.max(MIN_COLS, Math.min(MAX_COLS, Math.floor(this.canvasW / CELL_W)));
    this.rows = Math.max(MIN_ROWS, Math.min(MAX_ROWS, Math.floor(this.canvasH / CELL_H)));
  }

  /** The window grew or shrank: size the shown shell, and re-cut the tab labels. */
  private async onCanvasResize(): Promise<void> {
    const sessionId = this.activeSessionId;
    if (sessionId) {
      try {
        await this.request(request(this.id, sessionId, 'resize', { cols: this.cols, rows: this.rows }));
      } catch (err) { log.warn('resizing the terminal failed', err); }
    }
    await this.refreshStripLabels();
    const tab = activeTab(this.tabs);
    if (tab) this.revisions.delete(tab.sessionId);
    await this.refreshFrame(true);
  }

  /** Follow the shown program's own mouse-mode requests from its output. */
  private async refreshMouseMode(): Promise<void> {
    const tab = activeTab(this.tabs);
    if (!tab) return;
    const state = this.mouse.get(tab.sessionId) ?? { tracking: false, offset: 0 };
    try {
      const reply = await this.request<{ text: string; nextOffset: number }>(
        request(this.id, tab.sessionId as AbjectId, 'readOutput', { offset: state.offset, length: MOUSE_SCAN_CHARS }),
      );
      if (!reply.text || reply.text.length === 0) { this.mouse.set(tab.sessionId, state); return; }
      this.mouse.set(tab.sessionId, {
        tracking: scanMouseMode(state.tracking, reply.text),
        offset: reply.nextOffset,
      });
    } catch { /* the session may be gone; the next frame will find out */ }
  }

  // ── Lifecycle ──

  protected override async onStop(): Promise<void> {
    this.cancelRepaint();
    await this.teardownWindow();
    await super.onStop();
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    if (this.windowId) tabSetInvariants(this.tabs);
    invariant(!this.windowId || this.tabs.tabs.length <= MAX_TABS, 'the strip holds no more tabs than the cap');
    invariant(this.tabs.tabs.every(tab => this.tabWidgets.has(tab.id)) || this.tabs.tabs.length === 0,
      'every open tab has strip widgets');
    ensure(this.rootLayoutId === undefined || this.windowId !== undefined, 'a layout never outlives its window');
    invariant(this.cols >= MIN_COLS && this.cols <= MAX_COLS, 'the grid width stays in range');
    invariant(this.rows >= MIN_ROWS && this.rows <= MAX_ROWS, 'the grid height stays in range');
  }
}

