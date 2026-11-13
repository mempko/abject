/**
 * One program in a pseudo-terminal, addressed and controlled through Abject
 * messages: a shell the person approved for a terminal view, or the CLI of a
 * model provider they chose, run for the LLM object (see Terminal).
 *
 * The pseudo-terminal is `@lydell/node-pty` (loaded lazily, so importing this
 * module never touches a native addon) and the screen is libghostty's VT
 * engine - `@slopus/ghostty-wasm`, the prebuilt wasm build of libghostty-vt -
 * so the same emulator runs on every platform with no per-platform artifact.
 *
 * This object holds no policy of its own. It exists because a `Terminal`
 * capability decided the person approved one shell in one directory, and every
 * method admits only the session's owner (the view that opened it) and its
 * supervisor (`Terminal`). Nothing else can type into it or read it.
 *
 * Clipboard: this object never reads or writes a clipboard. OSC 52 replies from
 * the emulator are dropped rather than answered, and paste arrives as text the
 * caller obtained through the `Clipboard` capability, which asks PermissionBroker
 * itself. A program inside the session therefore cannot reach the person's
 * clipboard through the terminal.
 */
import { require as contractRequire } from '../../core/contracts.js';
import { Abject } from '../../core/abject.js';
import type { AbjectId, AbjectMessage, InterfaceId } from '../../core/types.js';
import { trackChild, untrackIfGone } from '../../runtime/child-processes.js';
import type { GhosttyColor, GhosttyRow, GhosttyStyle, GhosttyTerminal } from '@slopus/ghostty-wasm/node';

export const TERMINAL_SESSION_INTERFACE = 'abjects:terminal-session' as InterfaceId;

/** Everything one session needs; settled by the Terminal capability before it exists. */
export interface TerminalSessionSpec {
  /** The program to run in the pty (an absolute path, or a name the pty resolves). */
  command: string;
  args?: string[];
  /** The approved working directory; the whole session is scoped to it by consent. */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Inherited environment variables the program must not see, by name
   * prefix. Named here and removed in this process, so an environment never
   * travels in a message.
   */
  dropEnvPrefixes?: readonly string[];
  /** What the process is, for the list of children stopped at shutdown. */
  label?: string;
  cols: number;
  rows: number;
  maxScrollback?: number;
  /** The object that opened the session (the view). Only it and the supervisor may drive it. */
  owner: AbjectId;
  /** The Terminal capability that approved it. */
  supervisor: AbjectId;
  taskId?: string;
}

// The pty binding's shape, declared here so the native addon is only ever
// reached through a dynamic import.
interface PtyExitEvent { exitCode: number; signal?: number }
interface PtyProcess {
  readonly pid: number;
  onData(handler: (data: string) => void): void;
  onExit(handler: (event: PtyExitEvent) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface PtyModule { spawn(file: string, args: string[], options: Record<string, unknown>): PtyProcess }

/** Raw pty output kept for readOutput. The screen is the record of what was drawn. */
const MAX_RETAINED_CHARS = 1 << 20;
const DEFAULT_SCROLLBACK = 5000;
const MAX_COLS = 500;
const MAX_ROWS = 200;
/**
 * The most cells a screen may have. libghostty-vt 1.3.6 traps (a wasm
 * `unreachable`, after which the emulator is dead) when a program clears
 * lines and then enters the alternate screen on a screen of roughly 90,000
 * to 170,000 cells, which is what Claude Code does at startup; smaller
 * screens, the sizes terminals normally have, take the same bytes without
 * trouble. Found at 400x400; this stays clear of the range.
 */
export const MAX_SCREEN_CELLS = 80_000;
const MAX_READ_CHARS = 65536;
/** One repaint event per frame at most, however many pty chunks arrive. */
const OUTPUT_EVENT_MS = 16;

/** One styled cell as the view receives it. Omitted fields mean "the default". */
interface CellPayload {
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
interface RowPayload { wrapped: boolean; cells: CellPayload[] }

export class TerminalSession extends Abject {
  private proc?: PtyProcess;
  private term?: GhosttyTerminal;
  private pty?: PtyModule;

  private cols: number;
  private rows: number;
  private title = '';
  private seq = 0;

  private outputChars = 0;
  private retained = '';
  private screenError?: string;

  private stopping = false;
  private closed = false;
  private exitCode?: number;
  private exitSignal?: number;
  /** The screen as text, kept until output, a resize or a scroll changes it. */
  private textCache?: { outputChars: number; lines: string[]; wrapped: boolean[] };
  private sessionStartedAt = Date.now();
  private lastDataAt = 0;

  private outputTimer?: ReturnType<typeof setTimeout>;
  private killTimer?: ReturnType<typeof setTimeout>;
  private resolveCompletion!: () => void;
  private completion = new Promise<void>(resolve => { this.resolveCompletion = resolve; });

  constructor(private readonly spec: TerminalSessionSpec) {
    contractRequire(typeof spec.command === 'string' && spec.command.length > 0, 'a terminal session needs a program to run');
    contractRequire(typeof spec.cwd === 'string' && spec.cwd.length > 0, 'a terminal session needs a working directory');
    contractRequire(Number.isInteger(spec.cols) && spec.cols > 1, 'a terminal session needs at least two columns');
    contractRequire(Number.isInteger(spec.rows) && spec.rows > 1, 'a terminal session needs at least two rows');
    contractRequire(spec.cols * spec.rows <= MAX_SCREEN_CELLS, `a terminal session's screen holds at most ${MAX_SCREEN_CELLS} cells`);
    super({
      manifest: {
        name: 'TerminalSession',
        version: '1.0.0',
        description: 'One approved interactive shell in a pseudo-terminal. Read its screen, type into it, resize it, or close it through messages.',
        interface: {
          id: TERMINAL_SESSION_INTERFACE,
          name: 'TerminalSession',
          description: 'Owner- and supervisor-only control of one shell session',
          methods: [
            { name: 'status', description: 'Session state, size, title, pid and retained output size', parameters: [], returns: { kind: 'object', properties: {} } },
            { name: 'screen', description: 'The visible screen as styled rows with a cursor, palette and default colours', parameters: [{ name: 'sinceSeq', type: { kind: 'primitive', primitive: 'number' }, description: 'Only answer when the revision is newer than this', optional: true }], returns: { kind: 'object', properties: {} } },
            { name: 'text', description: 'The visible screen as plain text lines', parameters: [], returns: { kind: 'object', properties: {} } },
            { name: 'read', description: 'For a program driving the session: every visible row as text, which rows the terminal soft-wrapped onto the next, how long the program has been quiet, and whether it has exited', parameters: [], returns: { kind: 'object', properties: {} } },
            { name: 'write', description: 'Send keyboard input exactly as typed (an escape-sequence string)', parameters: [{ name: 'text', type: { kind: 'primitive', primitive: 'string' }, description: 'Bytes to type' }], returns: { kind: 'object', properties: {} } },
            { name: 'paste', description: 'Paste text, bracketed when the program asked for it', parameters: [{ name: 'text', type: { kind: 'primitive', primitive: 'string' }, description: 'Text to paste' }], returns: { kind: 'object', properties: {} } },
            { name: 'resize', description: 'Resize the pty and the screen together (cols/rows come from the view\u2019s cell metrics)', parameters: [{ name: 'cols', type: { kind: 'primitive', primitive: 'number' }, description: 'Columns' }, { name: 'rows', type: { kind: 'primitive', primitive: 'number' }, description: 'Rows' }], returns: { kind: 'object', properties: {} } },
            { name: 'scroll', description: 'Scroll the viewport by a number of rows (negative scrolls up)', parameters: [{ name: 'delta', type: { kind: 'primitive', primitive: 'number' }, description: 'Rows to scroll' }], returns: { kind: 'object', properties: {} } },
            { name: 'readOutput', description: 'Read recently retained raw output using character offset and length (maximum 64 Ki characters)', parameters: [{ name: 'offset', type: { kind: 'primitive', primitive: 'number' }, description: 'Character offset into the retained tail', optional: true }, { name: 'length', type: { kind: 'primitive', primitive: 'number' }, description: 'Character count', optional: true }], returns: { kind: 'object', properties: {} } },
            { name: 'close', description: 'Terminate the shell and release the pty; safe to repeat', parameters: [], returns: { kind: 'object', properties: {} } },
            { name: 'wait', description: 'Wait until the shell exits', parameters: [], returns: { kind: 'object', properties: {} } },
          ],
        },
        tags: ['capability', 'terminal'],
      },
    });
    this.cols = spec.cols;
    this.rows = spec.rows;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('status', (msg: AbjectMessage) => { this.authorize(msg); return this.sessionStatus(); });
    this.on('screen', (msg: AbjectMessage) => {
      this.authorize(msg);
      const { sinceSeq } = msg.payload as { sinceSeq?: number };
      const screen = this.screenPayload();
      if (typeof sinceSeq === 'number' && sinceSeq >= this.seq) return { ...screen, unchanged: true };
      return screen;
    });
    this.on('text', (msg: AbjectMessage) => { this.authorize(msg); return { lines: this.plainLines() }; });
    this.on('read', (msg: AbjectMessage) => {
      this.authorize(msg);
      const { lines, wrapped } = this.screenText();
      return {
        lines, wrapped,
        idleMs: this.lastDataAt > 0 ? Date.now() - this.lastDataAt : 0,
        exited: this.closed,
        // The emulator failed: what is on the screen can no longer be trusted.
        ...(this.screenError ? { screenError: this.screenError } : {}),
        ...(this.exitCode !== undefined ? { exitCode: this.exitCode } : {}),
        ...(this.exitSignal ? { signal: this.exitSignal } : {}),
      };
    });
    this.on('write', (msg: AbjectMessage) => {
      this.authorize(msg);
      const { text } = msg.payload as { text?: string };
      if (typeof text !== 'string' || text.length === 0) return { success: false, error: 'nothing to type' };
      if (this.closed || !this.proc) return { success: false, error: 'the shell has exited' };
      try { this.proc.write(text); } catch (err) { return { success: false, error: message(err) }; }
      return { success: true };
    });
    this.on('paste', (msg: AbjectMessage) => {
      this.authorize(msg);
      const { text } = msg.payload as { text?: string };
      if (typeof text !== 'string' || text.length === 0) return { success: false, error: 'nothing to paste' };
      if (this.closed || !this.proc) return { success: false, error: 'the shell has exited' };
      // A program that asked for bracketed paste gets it, so a paste cannot be
      // mistaken for typed keys by an editor or a shell prompt.
      try { this.proc.write(`\x1b[200~${text}\x1b[201~`); } catch (err) { return { success: false, error: message(err) }; }
      return { success: true };
    });
    this.on('resize', (msg: AbjectMessage) => {
      this.authorize(msg);
      const { cols, rows } = msg.payload as { cols?: number; rows?: number };
      this.applyResize(cols, rows);
      return { success: true, cols: this.cols, rows: this.rows };
    });
    this.on('scroll', (msg: AbjectMessage) => {
      this.authorize(msg);
      const { delta } = msg.payload as { delta?: number };
      const rows = Math.trunc(delta ?? 0);
      if (rows !== 0) { this.term?.scrollBy(rows); this.textCache = undefined; }
      const cursor = this.term?.snapshot().cursor ?? null;
      return { success: true, scrolled: rows, cursor };
    });
    this.on('readOutput', (msg: AbjectMessage) => {
      this.authorize(msg);
      const p = msg.payload as { offset?: number; length?: number };
      const offset = Math.max(0, Math.floor(p.offset ?? 0));
      const length = Math.max(1, Math.min(MAX_READ_CHARS, Math.floor(p.length ?? 8192)));
      const text = this.retained.slice(offset, offset + length);
      return { text, offset, nextOffset: offset + text.length, retainedChars: this.retained.length, totalChars: this.outputChars };
    });
    this.on('close', async (msg: AbjectMessage) => { this.authorize(msg); await this.close(); return this.sessionStatus(); });
    this.on('wait', async (msg: AbjectMessage) => { this.authorize(msg); await this.completion; return this.sessionStatus(); });
  }

  /**
   * Only the object that opened this session and the Terminal capability that
   * approved it may touch it. Same rule as RunningProcess: ownership is the
   * authorisation, and a name in a payload proves nothing.
   */
  private authorize(msg: AbjectMessage): void {
    if (msg.routing.from !== this.spec.owner && msg.routing.from !== this.spec.supervisor) {
      throw new Error('Terminal session belongs to another caller');
    }
  }

  protected override async onInit(): Promise<void> {
    const ptyImport = await import('@lydell/node-pty');
    this.pty = ((ptyImport as unknown as { default?: unknown }).default ?? ptyImport) as PtyModule;
    if (!this.pty?.spawn) throw new Error('@lydell/node-pty does not expose spawn()');

    const ghostty = await import('@slopus/ghostty-wasm/node');
    this.term = await ghostty.createGhosttyTerminal({
      cols: this.cols,
      rows: this.rows,
      maxScrollback: this.spec.maxScrollback ?? DEFAULT_SCROLLBACK,
    });
    const term = this.term;
    // The emulator answers terminal queries (device attributes, cursor reports).
    // Those go back to the program - except anything about the clipboard, which
    // this session must never answer for the person on its own.
    term.onPtyWrite(bytes => {
      const reply = Buffer.from(bytes).toString('utf8');
      if (reply.length === 0 || reply.includes('\x1b]52')) return;
      try { this.proc?.write(reply); } catch { /* the shell is gone */ }
    });

    const inherited: NodeJS.ProcessEnv = { ...process.env };
    const drop = this.spec.dropEnvPrefixes ?? [];
    if (drop.length > 0) {
      for (const key of Object.keys(inherited)) if (drop.some(prefix => key.startsWith(prefix))) delete inherited[key];
    }
    const proc = this.pty.spawn(this.spec.command, this.spec.args ?? [], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.spec.cwd,
      env: { ...inherited, ...this.spec.env, TERM: 'xterm-256color' },
    });
    this.proc = proc;
    // A pty child leads its own session, so the whole group is signalled at shutdown.
    trackChild(proc.pid, this.spec.label ?? `terminal: ${this.spec.command}`, { group: true });
    this.lastDataAt = Date.now();

    proc.onData(data => {
      this.lastDataAt = Date.now();
      this.retain(data);
      // A failed write leaves the emulator unusable: later output is kept
      // (readOutput) but no longer drawn, and readers are told (screenError).
      if (!this.screenError) {
        try { term.write(data); } catch (err) { this.screenError = message(err); }
      }
      this.scheduleOutputEvent();
    });
    proc.onExit(event => {
      this.exitCode = event.exitCode;
      this.exitSignal = event.signal;
      this.closed = true;
      if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = undefined; }
      untrackIfGone(proc.pid);
      this.changed('exit', this.sessionStatus());
      this.resolveCompletion();
      this.checkInvariants();
    });
  }

  private scheduleOutputEvent(): void {
    if (this.outputTimer) return;
    this.outputTimer = setTimeout(() => {
      this.outputTimer = undefined;
      this.changed('output', { sessionId: this.id, seq: this.seq, cols: this.cols, rows: this.rows });
    }, OUTPUT_EVENT_MS);
    this.outputTimer.unref?.();
  }

  private retain(data: string): void {
    this.outputChars += data.length;
    this.retained += data;
    if (this.retained.length > MAX_RETAINED_CHARS) {
      this.retained = this.retained.slice(this.retained.length - MAX_RETAINED_CHARS);
    }
  }

  private applyResize(cols?: number, rows?: number): void {
    const nextCols = Math.max(2, Math.min(MAX_COLS, Math.trunc(cols ?? this.cols)));
    const nextRows = Math.max(2, Math.min(MAX_ROWS, Math.floor(MAX_SCREEN_CELLS / nextCols), Math.trunc(rows ?? this.rows)));
    if (nextCols === this.cols && nextRows === this.rows) return;
    this.cols = nextCols;
    this.rows = nextRows;
    this.textCache = undefined;
    try { this.proc?.resize(nextCols, nextRows); } catch { /* exiting */ }
    try { this.term?.resize(nextCols, nextRows); } catch { /* disposed */ }
    this.changed('resize', { sessionId: this.id, cols: nextCols, rows: nextRows });
  }

  private sessionStatus(): Record<string, unknown> {
    return {
      sessionId: this.id,
      taskId: this.spec.taskId,
      state: this.closed ? 'exited' : this.stopping ? 'stopping' : 'running',
      pid: this.proc?.pid,
      cwd: this.spec.cwd,
      cols: this.cols,
      rows: this.rows,
      title: this.title,
      exitCode: this.exitCode,
      elapsedMs: Date.now() - this.sessionStartedAt,
      idleMs: this.lastDataAt > 0 ? Date.now() - this.lastDataAt : undefined,
      outputChars: this.outputChars,
      retainedChars: this.retained.length,
      screenError: this.screenError,
    };
  }

  /** The visible screen, in the form the view paints: styled cells, a cursor, a palette. */
  private screenPayload(): Record<string, unknown> {
    this.seq += 1;
    if (!this.term) {
      return { sessionId: this.id, seq: this.seq, cols: this.cols, rows: this.rows, ready: false, screenError: this.screenError };
    }
    const snapshot = this.term.snapshot();
    this.title = snapshot.title;
    const palette = snapshot.palette;
    const rows: RowPayload[] = snapshot.rows.map(row => this.rowPayload(row, palette));
    return {
      sessionId: this.id,
      seq: this.seq,
      revision: snapshot.outputRevision,
      ready: true,
      cols: snapshot.cols,
      rows: rows.length,
      title: snapshot.title,
      rowsData: undefined,
      screen: rows,
      totalRows: snapshot.totalRows,
      startRow: snapshot.startRow,
      visibleRows: snapshot.visibleRows,
      synchronizedOutputActive: snapshot.synchronizedOutputActive,
      cursor: snapshot.cursor ? { x: snapshot.cursor.x, y: snapshot.cursor.y, visible: snapshot.cursor.visible, shape: snapshot.cursor.shape, blinking: snapshot.cursor.blinking } : null,
      foreground: this.css(snapshot.defaultForeground, palette),
      background: this.css(snapshot.defaultBackground, palette),
      cursorColor: this.css(snapshot.cursorColor, palette),
      palette: palette.map(color => this.css(color, palette) ?? '#000000'),
      exitCode: this.exitCode,
    };
  }

  private rowPayload(row: GhosttyRow, palette: readonly GhosttyColor[]): RowPayload {
    // The emulator lists only the cells a program wrote, each with its
    // column. A program that moves the cursor over a gap instead of printing
    // spaces (most full-screen UIs do) leaves that gap out, so it is filled
    // here: the receiver lays cells out one after another.
    const cells: CellPayload[] = [];
    let column = 0;
    for (const cell of row.cells) {
      for (; column < cell.x; column++) cells.push({ text: ' ', width: 1 });
      const cellPayload = this.cellPayload(cell.text, cell.width, cell.style, cell.hyperlink, palette);
      cells.push(cellPayload);
      column = cell.x + cell.width;
    }
    // Trailing default-styled spaces carry no information; dropping them keeps
    // a full-screen repaint small without shifting any earlier cell.
    while (cells.length > 0) {
      const last = cells[cells.length - 1];
      if (last.text === ' ' && Object.keys(last).length === 2) cells.pop();
      else break;
    }
    return { wrapped: row.wrapped, cells };
  }

  private cellPayload(text: string, width: 1 | 2, style: GhosttyStyle, hyperlink: string | null, palette: readonly GhosttyColor[]): CellPayload {
    const payload: CellPayload = { text, width };
    const fg = this.css(style.foreground, palette);
    const bg = this.css(style.background, palette);
    const ulColor = this.css(style.underlineColor, palette);
    if (fg !== undefined) payload.fg = fg;
    if (bg !== undefined) payload.bg = bg;
    if (ulColor !== undefined) payload.ulColor = ulColor;
    if (style.bold) payload.bold = true;
    if (style.italic) payload.italic = true;
    if (style.dim) payload.dim = true;
    if (style.inverse) payload.inverse = true;
    if (style.invisible) payload.hidden = true;
    if (style.strikethrough) payload.strike = true;
    if (style.underline !== 'none') payload.underline = style.underline;
    if (hyperlink) payload.link = hyperlink;
    return payload;
  }

  /** A libghostty colour as a CSS string, resolving palette indices through the snapshot palette. */
  private css(color: GhosttyColor | null | undefined, palette: readonly GhosttyColor[], depth = 4): string | undefined {
    if (!color) return undefined;
    if (color.kind === 'rgb') return rgbCss(color.red, color.green, color.blue);
    if (depth <= 0) return undefined;
    const entry = palette[color.index];
    return entry ? this.css(entry, palette, depth - 1) : undefined;
  }

  /**
   * Every visible row as text, with the rows the terminal soft-wrapped onto
   * the next. A wrapped row keeps its trailing spaces (they belong to the
   * line it is part of); any other row loses them. Read from the emulator
   * only when something changed: a program polling a large screen for a
   * reply asks many times between outputs.
   */
  private screenText(): { lines: string[]; wrapped: boolean[] } {
    if (!this.term) return { lines: [], wrapped: [] };
    if (this.textCache?.outputChars === this.outputChars) return this.textCache;
    // An emulator that failed on a write stays failed; do not ask it again.
    if (this.screenError) return this.textCache ?? { lines: [], wrapped: [] };
    let snapshot;
    try {
      snapshot = this.term.snapshot();
    } catch (err) {
      this.screenError = message(err);
      return this.textCache ?? { lines: [], wrapped: [] };
    }
    const lines: string[] = [];
    const wrapped: boolean[] = [];
    for (const row of snapshot.rows) {
      // Cells carry their column, and the ones a program skipped with a
      // cursor move are not listed: put the spaces back.
      let text = '';
      let column = 0;
      for (const cell of row.cells) {
        if (cell.x > column) text += ' '.repeat(cell.x - column);
        text += cell.text;
        column = cell.x + cell.width;
      }
      lines.push(row.wrapped ? text : text.replace(/\s+$/, ''));
      wrapped.push(row.wrapped);
    }
    this.textCache = { outputChars: this.outputChars, lines, wrapped };
    return this.textCache;
  }

  /** The visible screen as plain lines, for a caller that wants text rather than cells. */
  private plainLines(): string[] {
    const lines = this.screenText().lines.map(line => line.replace(/\s+$/, ''));
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /** Terminate the shell and release the screen. Safe to call more than once. */
  async close(): Promise<void> {
    if (this.stopping) { await this.completion; return; }
    if (this.closed) { this.disposeScreen(); return; }
    this.stopping = true;
    try { this.proc?.kill(); } catch { /* already gone */ }
    // A shell that ignores the hangup gets a hard signal after a grace period.
    this.killTimer = setTimeout(() => {
      if (!this.proc?.pid) return;
      try { process.kill(-this.proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }, 2000);
    this.killTimer.unref?.();
    await this.completion;
    this.disposeScreen();
  }

  private disposeScreen(): void {
    try { this.term?.dispose(); } catch { /* nothing to release */ }
    this.term = undefined;
  }

  protected override async onStop(): Promise<void> {
    if (this.outputTimer) { clearTimeout(this.outputTimer); this.outputTimer = undefined; }
    if (!this.closed) {
      this.stopping = true;
      try { this.proc?.kill(); } catch { /* already gone */ }
      await this.completion;
    }
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = undefined; }
    untrackIfGone(this.proc?.pid);
    this.disposeScreen();
    this.resolveCompletion();
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    contractRequire(this.cols > 1 && this.rows > 1, 'a session always has a usable size');
    contractRequire(this.retained.length <= MAX_RETAINED_CHARS, 'retained output stays bounded');
  }
}

function rgbCss(red: number, green: number, blue: number): string {
  const channel = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0');
  return `#${channel(red)}${channel(green)}${channel(blue)}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
