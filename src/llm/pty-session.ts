/**
 * PtySession / PtySessionPool - drive an interactive CLI agent (claude,
 * codex) inside a real pseudo-terminal and reuse the warm process across
 * requests.
 *
 * Why: the CLI providers used to spawn a fresh process per request, paying
 * the binary's whole boot cost every time (measured: ~0.74s for `claude`,
 * ~1.1s for `codex`). Keeping one process alive and resetting its context
 * between requests removes that cost. A pseudo-terminal is what lets the
 * binary run its normal interactive session: it sees a TTY, starts its full
 * UI, and accepts keystrokes exactly as it would from a terminal emulator.
 *
 * How: `@lydell/node-pty` allocates the pty (prebuilt N-API binaries for
 * every desktop target, so no node-gyp and no per-Electron rebuild), and
 * `@xterm/headless` maintains a virtual screen from the raw byte stream.
 * Reading that screen is the same operation `tmux capture-pane` performs,
 * which is what makes this a tmux-shaped design without depending on tmux.
 *
 * KNOWN LIMITATION - this reads *rendered* text, so line breaks have to be
 * sorted into ones the model wrote and ones the layout added. Three things
 * do that, in descending order of certainty:
 *
 *   1. Terminal soft wraps are rejoined exactly: xterm records them on the
 *      buffer line as `isWrapped`, so there is nothing to infer.
 *   2. UI-inserted breaks are rejoined by inference, since the byte stream
 *      does not mark them. See {@link rejoinHardWraps}.
 *   3. {@link PtyDialect.cols} is set very wide so (2) is needed rarely.
 *
 * What survives all three: a model emitting a line whose length happens to
 * equal the UI's content width loses one newline. Callers needing byte-exact
 * output should prefer a provider that does not scrape a TUI.
 *
 * Everything here is backend-only. The pty and terminal modules load through
 * a dynamic import so this file stays importable from the client bundle and
 * from `PROVIDER_DESCRIPTORS`, which constructs providers purely to read
 * their manifests and must never start a process.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { require as requires, ensure, invariant, requirePositive } from '../core/contracts.js';

// ── Types ──────────────────────────────────────────────────────────────

/**
 * Everything that differs between one CLI agent's terminal UI and another's.
 * The pty plumbing, screen model, prompt injection, and pooling are shared;
 * only the patterns that recognise a particular UI live in a dialect.
 *
 * Keeping every UI-recognition pattern behind this one interface is
 * deliberate: these match on a rendering, not on a documented interface, so
 * a CLI release can change them. When that happens the fix is confined to
 * one dialect object rather than spread through the session logic.
 */
export interface PtyDialect {
  /** Stable id, used in errors and log lines. */
  readonly id: string;

  /** Binary to spawn, resolved via PATH unless absolute. */
  readonly bin: string;

  /** Argv for an interactive session (no print/headless flags). */
  readonly argv: readonly string[];

  /**
   * Virtual terminal width. Wide on purpose: the fewer lines the UI has to
   * wrap, the closer the captured text is to what the model emitted.
   */
  readonly cols: number;

  /**
   * Virtual terminal height. Tall on purpose: these UIs run on the
   * alternate screen buffer, which has NO scrollback, so any reply line
   * that scrolls past the top is gone for good. Rows are just memory
   * (rows x cols cells), so this buys correctness cheaply.
   */
  readonly rows: number;

  /** True once the UI is idle and ready to accept a prompt. */
  isReady(screen: string): boolean;

  /**
   * Keystrokes that dismiss a blocking startup dialog (trust prompts,
   * update offers), or undefined when nothing is blocking. Called only
   * while waiting for readiness.
   *
   * Returned as separate keystrokes, not one string, because these menus
   * are read a keypress at a time: an arrow key and the Enter that confirms
   * it, delivered in a single write, are consumed as one event and the
   * Enter activates whatever was selected *before* the arrow moved. That is
   * how "arrow down to Skip, then confirm" became "confirm Update now",
   * which runs an install and exits the session.
   */
  dismissKeys(screen: string): readonly string[] | undefined;

  /**
   * A human-readable reason the UI cannot proceed, for dialogs that must
   * NOT be answered automatically.
   *
   * Some prompts have a destructive option: codex's update offer runs
   * `npm install -g @openai/codex`, which replaces the binary underneath
   * the running process and kills the session. Driving a menu blind, by
   * arrow keys against a screen that may still be repainting, cannot be
   * made reliably safe, and getting it wrong means an Abjects request
   * silently reinstalls one of the user's global packages. Failing with an
   * explanation the user can act on is the better trade.
   */
  blockedReason?(screen: string): string | undefined;

  /** Text that wipes conversation context in place, e.g. `/clear`. */
  readonly clearCommand: string;

  /**
   * True once the UI shows the current turn has finished, for UIs that
   * print an explicit end-of-turn marker. Return false for UIs that print
   * none; {@link isIdle} then carries the detection instead.
   */
  isTurnComplete(screen: string): boolean;

  /**
   * True when the UI looks like it is waiting for input rather than
   * working. Weaker than {@link isTurnComplete} because it also holds
   * before a prompt is submitted, so it only ends a turn in combination
   * with a sustained pause in output.
   */
  isIdle(screen: string): boolean;

  /**
   * True while the UI is actively working on a turn.
   *
   * Used to confirm a submission actually landed. Without that check a
   * prompt that never reached the input box looks identical to a finished
   * turn (quiet UI, no new output), and the previous turn's text would be
   * returned as this turn's reply.
   */
  isBusy(screen: string): boolean;

  /**
   * True for a line that is UI furniture rather than model output: status
   * bars, input box borders, banners, hints.
   */
  isChrome(line: string): boolean;

  /**
   * True for the line that begins an assistant reply, which these UIs mark
   * with a bullet.
   *
   * This is the anchor extraction starts from, and it has to be the bullet
   * rather than the echoed input: the input box prefixes only the *first*
   * line of a submitted block, so anchoring on the echo would sweep every
   * continuation line of the prompt into the reply.
   */
  isReplyStart(line: string): boolean;

  /**
   * Environment overrides for the child. The base environment is the
   * parent's with the caller's additions applied.
   */
  env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}

/** Tunables shared by every session. */
export interface PtySessionOptions {
  /** Working directory for the child process. */
  cwd?: string;
  /**
   * How long the child may produce no output at all before the turn is
   * declared hung. Resets on every byte, so a long-but-progressing
   * generation keeps running.
   */
  idleTimeoutMs?: number;
  /** Cap on a single turn regardless of progress. */
  turnTimeoutMs?: number;
  /** Cap on reaching a ready UI after spawn. */
  startupTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 360_000;
const DEFAULT_TURN_TIMEOUT_MS = 900_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 90_000;

/** Poll interval for screen predicates. Cheap: reads an in-memory buffer. */
const POLL_MS = 120;

/**
 * Quiet period after a completion marker before the screen is read. The UI
 * repaints a few times as a turn settles; reading mid-repaint can capture a
 * half-drawn frame.
 */
const SETTLE_QUIET_MS = 700;
const SETTLE_CAP_MS = 15_000;

/**
 * How long an idle-looking UI must produce no output before a turn counts as
 * finished on that evidence alone. Generous, because a model that pauses
 * mid-turn (waiting on a tool, thinking between blocks) briefly looks the
 * same; the precise signals win long before this matters.
 */
const IDLE_COMPLETION_MS = 6_000;

/**
 * How long to wait for evidence that a submitted prompt was accepted. Only
 * has to cover the UI reacting to a keystroke, not the model answering.
 */
const SUBMIT_CONFIRM_MS = 30_000;

/**
 * Pause between typing a slash command and pressing Enter, so the UI's
 * command-completion popup settles and the Enter reaches the command.
 */
const COMMAND_SUBMIT_DELAY_MS = 500;

/**
 * Gap between the individual keystrokes that answer a dialog, so a menu
 * reading one keypress at a time sees them as distinct events.
 */
const DIALOG_KEY_GAP_MS = 300;

/** Give up answering a dialog that keeps coming back. */
const MAX_DIALOG_DISMISSALS = 3;

/**
 * How wide the widest line must be, as a fraction of the terminal, before
 * it is treated as the UI's wrap boundary rather than just a long line.
 */
const WRAP_DETECT_RATIO = 0.8;

/** Prompt injection chunk size, tuned to stay under pty write buffering. */
const WRITE_CHUNK = 2048;
const WRITE_CHUNK_PAUSE_MS = 6;

// Minimal structural types for the lazily imported modules, so this file
// carries no compile-time dependency on their shapes.
interface PtyProcess {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
interface BufferLine { translateToString(trimRight?: boolean): string; readonly isWrapped: boolean; }
interface TerminalBuffer { readonly viewportY: number; getLine(y: number): BufferLine | undefined; }
interface TerminalLike {
  readonly rows: number;
  readonly buffer: { readonly active: TerminalBuffer };
  write(data: string): void;
  dispose(): void;
}

let ptyModule: { spawn(file: string, args: string[], opts: Record<string, unknown>): PtyProcess } | undefined;
let terminalCtor: (new (opts: Record<string, unknown>) => TerminalLike) | undefined;

/**
 * Load the native pty binding and the headless terminal on first use.
 *
 * Dynamic so that merely importing this module (which the provider registry
 * does at startup, and the client bundle does transitively) never touches a
 * native addon.
 */
async function loadPtyDeps(): Promise<void> {
  if (ptyModule && terminalCtor) return;
  const [pty, xterm] = await Promise.all([
    import('@lydell/node-pty'),
    import('@xterm/headless'),
  ]);
  // Both ship CommonJS, so the useful shape may sit under `default`.
  const ptyNs = (pty as unknown as { default?: unknown }).default ?? pty;
  const xtermNs = (xterm as unknown as { default?: unknown }).default ?? xterm;
  ptyModule = ptyNs as typeof ptyModule;
  terminalCtor = (xtermNs as { Terminal: NonNullable<typeof terminalCtor> }).Terminal;
  ensure(!!ptyModule?.spawn, 'node-pty exposes spawn()');
  ensure(!!terminalCtor, '@xterm/headless exposes Terminal');
}

// ── Session ────────────────────────────────────────────────────────────

export type PtySessionState = 'new' | 'starting' | 'ready' | 'busy' | 'dead';

/**
 * One warm interactive CLI process plus the virtual screen it draws on.
 *
 * Not safe for concurrent turns: {@link ask} takes the session busy for its
 * whole duration. Concurrency comes from running several sessions in a
 * {@link PtySessionPool}.
 */
export class PtySession {
  private proc?: PtyProcess;
  private term?: TerminalLike;
  private state: PtySessionState = 'new';
  private lastDataAt = 0;
  private exitInfo?: { exitCode: number; signal?: number };

  /** Turns served since spawn; drives pool recycling. */
  private turns = 0;

  private readonly idleTimeoutMs: number;
  private readonly turnTimeoutMs: number;
  private readonly startupTimeoutMs: number;
  private readonly cwd?: string;

  constructor(
    private readonly dialect: PtyDialect,
    options: PtySessionOptions = {},
  ) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.cwd = options.cwd;
    requirePositive(this.idleTimeoutMs, 'idleTimeoutMs');
    requirePositive(this.turnTimeoutMs, 'turnTimeoutMs');
    requirePositive(this.startupTimeoutMs, 'startupTimeoutMs');
    this.checkInvariants();
  }

  get isAlive(): boolean { return this.state !== 'dead' && this.state !== 'new'; }
  get turnsServed(): number { return this.turns; }
  get currentState(): PtySessionState { return this.state; }

  checkInvariants(): void {
    invariant(this.turns >= 0, 'turns served never negative');
    invariant(
      this.state === 'new' || this.state === 'dead' || this.proc !== undefined,
      'a started session owns a pty process',
    );
    invariant(
      this.proc === undefined || this.term !== undefined,
      'a session with a pty also has a screen',
    );
  }

  /**
   * Spawn the child and wait until its UI accepts input, answering any
   * blocking startup dialog on the way.
   */
  async start(): Promise<void> {
    requires(this.state === 'new', `cannot start a session in state '${this.state}'`);
    this.state = 'starting';
    await loadPtyDeps();

    const term = new terminalCtor!({
      cols: this.dialect.cols,
      rows: this.dialect.rows,
      allowProposedApi: true,
      // The UI runs on the alternate buffer, which keeps no scrollback, so
      // this only matters for the brief pre-UI phase.
      scrollback: 1000,
    });
    this.term = term;

    const env = this.dialect.env({ ...process.env });
    let proc: PtyProcess;
    try {
      proc = ptyModule!.spawn(this.dialect.bin, [...this.dialect.argv], {
        name: 'xterm-256color',
        cols: this.dialect.cols,
        rows: this.dialect.rows,
        // Each session gets its own empty directory unless told otherwise.
        cwd: this.cwd ?? sessionSandboxDir(),
        env,
      });
    } catch (err) {
      this.state = 'dead';
      this.term?.dispose();
      this.term = undefined;
      throw new Error(
        `${this.dialect.id}: failed to spawn '${this.dialect.bin}' in a pty: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.proc = proc;
    this.lastDataAt = Date.now();
    proc.onData((d) => { this.lastDataAt = Date.now(); term.write(d); });
    proc.onExit((e) => { this.exitInfo = e; this.state = 'dead'; });

    try {
      await this.waitForReady(this.startupTimeoutMs);
    } catch (err) {
      this.dispose();
      throw err;
    }

    this.state = 'ready';
    this.checkInvariants();
  }

  /**
   * Run one turn: reset context, inject `prompt`, wait for the reply, and
   * return it as text.
   *
   * A per-request nonce is appended so the end of the reply can be located
   * exactly. The instruction sentence necessarily contains the nonce too and
   * is echoed back by the input box, so the terminator is recognised only on
   * a line that holds the nonce *alone*, which the echoed instruction never
   * produces.
   */
  async ask(prompt: string, opts: { reset?: boolean } = {}): Promise<string> {
    requires(this.state === 'ready', `cannot ask a session in state '${this.state}'`);
    requires(prompt.length > 0, 'prompt must not be empty');
    this.state = 'busy';
    try {
      // Both paths end at a ready, dialog-free UI: reset() re-establishes
      // readiness itself, and without it the prompt would still be typed
      // into whatever dialog appeared since the last turn.
      if (opts.reset !== false) await this.reset();
      else await this.waitForReady(30_000);

      const nonce = `ABJ-END-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
      const marked =
        `${prompt}\n\n` +
        `When you have finished your entire reply, output this marker alone on the final line: ${nonce}`;

      await this.inject(marked);

      // Confirm the submission landed before looking for a reply. A paste
      // that the input box dropped (because the UI was still repainting)
      // leaves a quiet, idle-looking screen that is indistinguishable from
      // a completed turn, and the previous turn's text would be harvested
      // as this one's answer.
      await this.waitFor(
        (screen, lines) =>
          this.dialect.isBusy(screen)
          || this.dialect.isTurnComplete(screen)
          || lines.some(l => l.trim() === nonce),
        'turn to start',
        SUBMIT_CONFIRM_MS,
      );

      // Three independent ways to see a finished turn, so no single UI
      // detail can stall a request:
      //   1. the terminator landed on a line of its own (most precise),
      //   2. the UI printed an explicit end-of-turn marker,
      //   3. the UI looks idle and has stopped producing output entirely.
      // The third exists for UIs that print no end-of-turn marker at all,
      // and as the backstop when a model omits the terminator.
      await this.waitFor(
        (screen, lines) =>
          lines.some(l => l.trim() === nonce)
          || this.dialect.isTurnComplete(screen)
          || (this.dialect.isIdle(screen) && Date.now() - this.lastDataAt >= IDLE_COMPLETION_MS),
        'turn to complete',
        this.turnTimeoutMs,
      );
      await this.settle();

      const reply = this.extractReply(nonce);
      this.turns++;
      this.state = 'ready';
      this.checkInvariants();
      ensure(this.state === 'ready', 'session returns to ready after a completed turn');
      return reply;
    } catch (err) {
      // A failed turn leaves the UI in an unknown state; the session is no
      // longer trustworthy for reuse, so the pool must discard it.
      this.state = 'dead';
      throw err;
    }
  }

  /**
   * Wipe conversation context in place and wait for the UI to settle.
   *
   * The settle before checking readiness is load-bearing: clearing repaints
   * the whole screen, and the UI looks ready both before it has processed
   * the command and after. Returning on the first of those means the next
   * prompt is pasted into a repainting input box, which silently drops it
   * and leaves the old conversation in place.
   */
  async reset(): Promise<void> {
    requires(this.isAlive, 'cannot reset a dead session');

    // Confirm the UI is ready and dialog-free BEFORE typing anything. These
    // CLIs raise dialogs at any time, not only at startup (codex checks for
    // updates periodically), and a dialog that appears between turns is
    // still on screen when the reset command is typed. The command text
    // then goes to the dialog and the Enter after it activates whatever was
    // selected: for codex's update prompt that is "Update now", which runs
    // an install and exits the session. This presented as maddeningly
    // intermittent failures until the dialog was identified as the cause.
    await this.waitForReady(30_000);

    // Type the command, then submit as a separate keystroke. These UIs pop
    // up a command-completion list as soon as "/" is typed, and a carriage
    // return arriving in the same write is consumed by that list instead of
    // running the command, which silently leaves the conversation intact.
    this.write(this.dialect.clearCommand);
    await sleep(COMMAND_SUBMIT_DELAY_MS);
    this.write('\r');
    await this.settle();
    await this.waitForReady(30_000);
    await this.settle();
  }

  /** Kill the child and release the screen. */
  dispose(): void {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* already gone */ }
      this.proc = undefined;
    }
    if (this.term) {
      try { this.term.dispose(); } catch { /* nothing to release */ }
      this.term = undefined;
    }
    this.state = 'dead';
  }

  // ── Internals ────────────────────────────────────────────────────────

  private write(data: string): void {
    requires(this.proc !== undefined, 'cannot write to a session with no pty');
    this.proc.write(data);
  }

  /**
   * Send a prompt the way a terminal emulator does when text is pasted.
   *
   * Bracketed paste (ESC[200~ / ESC[201~) is what keeps multi-line prompts
   * intact: inside the brackets a newline is content, so the input box does
   * not treat the first line break as "submit". The carriage return that
   * follows the closing bracket is the actual submit keystroke.
   */
  private async inject(text: string): Promise<void> {
    this.write('\x1b[200~');
    for (let i = 0; i < text.length; i += WRITE_CHUNK) {
      this.write(text.slice(i, i + WRITE_CHUNK));
      await sleep(WRITE_CHUNK_PAUSE_MS);
    }
    this.write('\x1b[201~');
    // Let the UI finish laying out the pasted block before submitting;
    // submitting into a still-rendering input box can drop the tail.
    await sleep(400);
    this.write('\r');
  }

  /**
   * Wait for a ready UI, dismissing any blocking dialog encountered.
   *
   * Answering a dialog is rate-limited, and that is not a nicety. The
   * readiness predicate runs every poll interval, so an unthrottled version
   * re-sends the dismissal several times before the UI has even repainted.
   * On a menu driven by arrow keys those extra keystrokes keep moving the
   * selection, and the following Enter activates whatever it landed on.
   * Observed: codex's update prompt getting walked onto "Update now", which
   * runs an install and exits the session.
   */
  private async waitForReady(capMs: number): Promise<void> {
    const deadline = Date.now() + capMs;
    let dismissals = 0;

    for (;;) {
      if (this.state === 'dead' && this.exitInfo) {
        throw new Error(
          `${this.dialect.id}: process exited (code=${this.exitInfo.exitCode}) while waiting for the UI to become ready`,
        );
      }

      const screen = this.screenLines().join('\n');
      if (this.dialect.isReady(screen)) return;

      const blocked = this.dialect.blockedReason?.(screen);
      if (blocked) throw new Error(`${this.dialect.id}: ${blocked}`);

      const keys = this.dialect.dismissKeys(screen);
      // Bounded: a dialog that re-appears forever is a broken install, not
      // something to keep answering.
      if (keys && dismissals < MAX_DIALOG_DISMISSALS) {
        dismissals++;
        for (const key of keys) {
          this.write(key);
          await sleep(DIALOG_KEY_GAP_MS);
        }
        // Let the UI act on the answer before deciding whether to answer
        // again, so a dialog is never dismissed twice over.
        await this.settle();
        continue;
      }

      const idleFor = Date.now() - this.lastDataAt;
      if (idleFor >= this.idleTimeoutMs) {
        throw new Error(
          `${this.dialect.id}: no output for ${idleFor}ms while waiting for the UI to become ready`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(`${this.dialect.id}: timed out after ${capMs}ms waiting for the UI to become ready`);
      }
      await sleep(POLL_MS);
    }
  }

  /**
   * Poll `pred` against the rendered screen until it holds.
   *
   * Fails on three conditions, each reported distinctly because they mean
   * different things to the caller: the child died, it went silent for the
   * idle window, or the overall cap elapsed while it was still producing
   * output.
   */
  private async waitFor(
    pred: (screen: string, lines: string[]) => boolean,
    what: string,
    capMs: number,
  ): Promise<void> {
    const deadline = Date.now() + capMs;
    for (;;) {
      if (this.state === 'dead' && this.exitInfo) {
        throw new Error(
          `${this.dialect.id}: process exited (code=${this.exitInfo.exitCode}` +
          `${this.exitInfo.signal ? `, signal=${this.exitInfo.signal}` : ''}) while waiting for ${what}`,
        );
      }
      const lines = this.screenLines();
      if (pred(lines.join('\n'), lines)) return;

      const idleFor = Date.now() - this.lastDataAt;
      if (idleFor >= this.idleTimeoutMs) {
        throw new Error(
          `${this.dialect.id}: no output for ${idleFor}ms while waiting for ${what} (session abandoned)`,
        );
      }
      if (Date.now() >= deadline) {
        throw new Error(`${this.dialect.id}: timed out after ${capMs}ms waiting for ${what}`);
      }
      await sleep(POLL_MS);
    }
  }

  /** Wait for a brief pause in output so the screen is not read mid-repaint. */
  private async settle(): Promise<void> {
    const deadline = Date.now() + SETTLE_CAP_MS;
    while (Date.now() < deadline) {
      if (Date.now() - this.lastDataAt >= SETTLE_QUIET_MS) return;
      await sleep(60);
    }
  }

  /** The visible screen as plain text lines, chrome included. */
  private screenLines(): string[] {
    if (!this.term) return [];
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      out.push(line ? line.translateToString(true).trimEnd() : '');
    }
    return out;
  }

  /**
   * The visible screen with terminal soft wraps rejoined.
   *
   * When the terminal itself wraps a long line, xterm flags the continuation
   * with `isWrapped`, so those fragments can be concatenated back into the
   * original line exactly. Breaks the UI inserted itself carry no such flag
   * and are indistinguishable from real newlines; see the file header.
   */
  private unwrappedLines(): string[] {
    if (!this.term) return [];
    const buf = this.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < this.term.rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      if (!line) { out.push(''); continue; }
      const text = line.translateToString(true).trimEnd();
      if (line.isWrapped && out.length > 0) out[out.length - 1] += text;
      else out.push(text);
    }
    return out;
  }

  /**
   * Pull the model's reply out of the rendered screen.
   *
   * Bounded at the end by the terminator line when present, and at the
   * start by the last assistant bullet before it, so neither the echoed
   * prompt nor a previous turn still on screen can bleed in.
   */
  private extractReply(nonce: string): string {
    const lines = this.unwrappedLines();

    let end = lines.findIndex(l => l.trim() === nonce);
    if (end < 0) end = lines.length;

    let start = -1;
    for (let i = end - 1; i >= 0; i--) {
      const line = lines[i];
      if (this.dialect.isReplyStart(line) && !this.dialect.isChrome(line)) { start = i; break; }
    }
    if (start < 0) {
      throw new Error(
        `${this.dialect.id}: no assistant reply found on screen. ` +
        `Last rendered lines: ${JSON.stringify(lines.filter(l => l.trim()).slice(-8))}`,
      );
    }

    const block = lines.slice(start, end).filter(l => !this.dialect.isChrome(l));
    // The bullet marks the first line only; the rest of the reply is
    // indented to align under it. Blanking the bullet to spaces of the same
    // width (rather than deleting it) keeps the block uniformly indented,
    // so the dedent below sees the alignment and strips it from every line.
    const aligned = block.map((l, i) => (i === 0 ? l.replace(/^\S\s*/, m => ' '.repeat(m.length)) : l));
    // Dedent BEFORE rejoining: a wrapped segment continues at the block's
    // left margin, so the indent has to be gone for the pieces to abut.
    const body = rejoinHardWraps(dedent(aligned), this.dialect.cols)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    if (!body) {
      throw new Error(
        `${this.dialect.id}: assistant reply was empty after filtering. ` +
        `Raw block: ${JSON.stringify(block.slice(0, 8))}`,
      );
    }
    return body;
  }
}

// ── Pool ───────────────────────────────────────────────────────────────

export interface PtyPoolOptions extends PtySessionOptions {
  /** Maximum warm sessions. Each is a live child process. */
  maxSessions?: number;
  /** Recycle a session after this many turns to bound UI/state drift. */
  maxTurnsPerSession?: number;
  /** Kill an idle session after this long to stop holding a process forever. */
  idleEvictMs?: number;
}

interface PooledSession { session: PtySession; leased: boolean; idleSince: number; }

/**
 * A caller queued behind a full pool. Both outcomes are kept: dropping the
 * reject half would leave a queued request pending forever whenever the
 * pool closes or a replacement session fails to start.
 */
interface Waiter {
  resolve(entry: PooledSession): void;
  reject(err: Error): void;
}

/**
 * A small pool of warm {@link PtySession}s.
 *
 * Sessions are leased for the duration of one request because a terminal UI
 * has exactly one input box and one transcript: two concurrent turns on one
 * session would interleave on the same screen. Parallel requests therefore
 * need parallel sessions, which is what `maxSessions` bounds.
 */
export class PtySessionPool {
  private readonly sessions: PooledSession[] = [];
  private readonly waiters: Waiter[] = [];
  private readonly maxSessions: number;
  private readonly maxTurnsPerSession: number;
  private readonly idleEvictMs: number;
  private evictTimer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly dialect: PtyDialect,
    private readonly options: PtyPoolOptions = {},
  ) {
    this.maxSessions = options.maxSessions ?? 2;
    this.maxTurnsPerSession = options.maxTurnsPerSession ?? 50;
    this.idleEvictMs = options.idleEvictMs ?? 10 * 60_000;
    requirePositive(this.maxSessions, 'maxSessions');
    requirePositive(this.maxTurnsPerSession, 'maxTurnsPerSession');
    requirePositive(this.idleEvictMs, 'idleEvictMs');
    this.checkInvariants();
  }

  checkInvariants(): void {
    invariant(this.sessions.length <= this.maxSessions, 'pool never exceeds its session cap');
    invariant(
      this.sessions.filter(s => s.leased).length + this.sessions.filter(s => !s.leased).length
        === this.sessions.length,
      'every pooled session is either leased or idle',
    );
    invariant(
      this.waiters.length === 0 || this.sessions.every(s => s.leased),
      'callers only wait when every session is leased',
    );
  }

  /**
   * Run one turn on a warm session, creating or waiting for one as needed.
   *
   * The lease is always returned, including on failure: a session whose turn
   * threw is discarded rather than reused, because the UI is left in an
   * unknown state.
   */
  async ask(prompt: string): Promise<string> {
    requires(!this.closed, 'cannot use a closed pty pool');
    const entry = await this.acquire();
    try {
      const reply = await entry.session.ask(prompt);
      this.release(entry);
      return reply;
    } catch (err) {
      this.discard(entry);
      throw err;
    }
  }

  /** Number of live child processes, for diagnostics. */
  get size(): number { return this.sessions.length; }

  /** Kill every session and refuse further work. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.evictTimer) { clearInterval(this.evictTimer); this.evictTimer = undefined; }
    for (const entry of this.sessions.splice(0)) {
      try { entry.session.dispose(); } catch { /* best effort */ }
    }
    // Fail anyone still queued rather than leaving their request pending
    // against a pool that will never serve it.
    for (const waiter of this.waiters.splice(0)) {
      waiter.reject(new Error(`${this.dialect.id}: pool closed while the request was queued`));
    }
    this.checkInvariants();
  }

  private async acquire(): Promise<PooledSession> {
    const idle = this.sessions.find(s => !s.leased);
    if (idle) {
      // Recycle before handing out rather than after returning, so a stale
      // session is never the one that serves a request.
      if (idle.session.turnsServed >= this.maxTurnsPerSession || !idle.session.isAlive) {
        this.discard(idle);
        return this.acquire();
      }
      idle.leased = true;
      this.checkInvariants();
      return idle;
    }

    if (this.sessions.length < this.maxSessions) {
      const session = new PtySession(this.dialect, this.options);
      const entry: PooledSession = { session, leased: true, idleSince: Date.now() };
      this.sessions.push(entry);
      this.ensureEvictTimer();
      try {
        await session.start();
      } catch (err) {
        // Never leave a half-started session occupying a slot.
        this.discard(entry);
        throw err;
      }
      this.checkInvariants();
      return entry;
    }

    return new Promise<PooledSession>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private release(entry: PooledSession): void {
    entry.leased = false;
    entry.idleSince = Date.now();
    this.handOff(entry);
    this.checkInvariants();
  }

  private discard(entry: PooledSession): void {
    try { entry.session.dispose(); } catch { /* best effort */ }
    const i = this.sessions.indexOf(entry);
    if (i >= 0) this.sessions.splice(i, 1);
    // A freed slot lets the next queued caller build a replacement session.
    const waiter = this.waiters.shift();
    if (waiter) {
      void this.acquire().then(waiter.resolve, waiter.reject);
    }
    this.checkInvariants();
  }

  /** Give a just-freed session to the longest-waiting caller, if any. */
  private handOff(entry: PooledSession): void {
    const waiter = this.waiters.shift();
    if (!waiter) return;
    entry.leased = true;
    waiter.resolve(entry);
  }

  private ensureEvictTimer(): void {
    if (this.evictTimer || this.closed) return;
    this.evictTimer = setInterval(() => {
      const now = Date.now();
      for (const entry of [...this.sessions]) {
        if (!entry.leased && now - entry.idleSince >= this.idleEvictMs) this.discard(entry);
      }
      if (this.sessions.length === 0 && this.evictTimer) {
        clearInterval(this.evictTimer);
        this.evictTimer = undefined;
      }
    }, Math.min(this.idleEvictMs, 60_000));
    // Never hold the process open on this timer alone.
    (this.evictTimer as unknown as { unref?: () => void }).unref?.();
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Remove the deepest indent shared by every non-blank line.
 *
 * These UIs indent a reply's continuation lines to align under the bullet
 * that starts it. That alignment is layout, not content, so it has to come
 * off; taking the *common* indent preserves any relative indentation the
 * model itself wrote (nested lists, code blocks).
 */
/**
 * Rejoin lines the UI hard-wrapped to fit its own width.
 *
 * The terminal's own soft wraps are already handled exactly, via xterm's
 * `isWrapped` flag. This covers the other case: a UI that lays text out
 * itself and emits a real line break to fit its content column. Nothing in
 * the byte stream distinguishes that break from one the model wrote, so it
 * has to be inferred.
 *
 * The inference: no rendered line can be wider than the content column, so
 * the widest line in a reply IS that column whenever a wrap happened. A
 * line ending exactly at it is therefore a wrapped fragment and continues
 * on the next line.
 *
 * Guarded two ways against a reply that merely contains one long line:
 * the widest line must be a large fraction of the terminal width (a short
 * reply never triggers this at all), and an empty following line is never
 * treated as a continuation, since a wrap always carries text over.
 *
 * The residual false positive is a model emitting a line whose length is
 * exactly the content width, which would lose one newline. That is far
 * rarer than the corruption it prevents: without this, any long unbroken
 * token gets a newline injected into its middle. Observed in production
 * splitting a URL's `America/Los_Angeles` across two lines.
 */
function rejoinHardWraps(lines: string[], termCols: number): string[] {
  let width = 0;
  for (const line of lines) width = Math.max(width, line.length);
  // Too narrow to be a wrap boundary: this reply simply has no long lines.
  if (width < termCols * WRAP_DETECT_RATIO) return lines;

  const out: string[] = [];
  for (const line of lines) {
    const prev = out.length > 0 ? out[out.length - 1] : undefined;
    const continues = prev !== undefined && prev.length >= width && line.length > 0;
    if (continues) out[out.length - 1] = prev + line;
    else out.push(line);
  }
  return out;
}

function dedent(lines: string[]): string[] {
  let common = Infinity;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent < common) common = indent;
  }
  if (!Number.isFinite(common) || common === 0) return lines;
  return lines.map(l => (l.trim() === '' ? l : l.slice(common)));
}

/**
 * Strip environment variables a parent CLI agent exports to its children.
 *
 * Without this, a session launched from inside one of these agents inherits
 * markers that make the child believe it is a nested run, which changes its
 * behaviour (observed: transcript persistence silently disabled).
 */
export function scrubAgentEnv(base: NodeJS.ProcessEnv, prefixes: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, TERM: 'xterm-256color' };
  for (const key of Object.keys(env)) {
    if (prefixes.some(p => key.startsWith(p))) delete env[key];
  }
  return env;
}

/**
 * An empty directory to run CLI sessions in, created on first use.
 *
 * Not every CLI can be made toolless. Codex in particular keeps filesystem
 * reads and command execution no matter which flags are set (verified: with
 * a read-only sandbox, no MCP, approvals off, and `unified_exec` disabled,
 * it still read a file and returned its contents). Starting the session
 * somewhere empty means that residual capability has nothing of the user's
 * to reach, and it also keeps the working directory's own project files
 * from being pulled into a request.
 *
 * Shared across sessions because it holds nothing; it exists to be boring.
 */
let sandboxCounter = 0;

export function sessionSandboxDir(): string {
  // A directory per session, not one shared by all of them. These CLIs keep
  // per-directory state (thread stores, session records), and two live
  // sessions pointed at the same directory interfere: observed as one of
  // them exiting on its own with code 0, intermittently and with no message.
  sandboxCounter++;
  const dir = join(tmpdir(), 'abjects-cli-sessions', `s${process.pid}-${sandboxCounter}`);
  mkdirSync(dir, { recursive: true });
  // Codex refuses to start outside a trusted directory, and treats any git
  // work tree as trusted ("Not inside a trusted directory and
  // --skip-git-repo-check was not specified", then exit 0). An empty repo
  // is the least invasive way to satisfy that. Best effort: if git is
  // missing the session simply fails to start, with codex's own message.
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  } catch { /* no git, or already initialised */ }
  return dir;
}
