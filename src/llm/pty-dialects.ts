/**
 * Terminal-UI dialects for the CLI agents Abjects drives through a pty.
 *
 * EVERY pattern in this file matches on a *rendering*, not on a documented
 * interface, so a CLI release can invalidate any of them. That is exactly
 * why they all live here: when a UI changes, this is the only file to edit.
 *
 * Each pattern below was derived by driving the real binary through a pty
 * and reading the rendered screen, not from documentation. The comments
 * record what was observed so a future reader can tell an intentional
 * pattern from a guess.
 *
 * Observed with claude 2.1.231 and codex 0.144.5 (August 2026).
 */

import type { PtyDialect } from './pty-session.js';
import { scrubAgentEnv } from './pty-session.js';

/**
 * Wide and tall on purpose.
 *
 * Width: these UIs lay text out to fit the terminal, and a break the UI
 * inserts is indistinguishable from one the model emitted. More columns
 * means fewer inserted breaks.
 *
 * Height: the UIs run on the alternate screen buffer, which keeps NO
 * scrollback, so anything that scrolls past the top is unrecoverable. A
 * 400-line reply needs 400 rows. Cost is one cell per row/column pair in
 * memory, which is nothing next to a language model call.
 */
const COLS = 400;
const ROWS = 400;

/** Long horizontal rules the UIs draw around their input boxes. */
const RULE = /[─━]{10,}/;

// ── Claude Code ────────────────────────────────────────────────────────

/**
 * The end-of-turn line, e.g. "✻ Cogitated for 6s" or "✻ Worked for 1s".
 *
 * The verb is randomised per turn (observed: Worked, Cogitated), so it must
 * not be matched literally. The glyph set covers the spinner frames the
 * same line is drawn with.
 */
const CLAUDE_TURN_DONE = /[✻✽✢✳✶*·]\s+\w+\s+for\s+\d+/;

/** Shown while a turn is running; its absence is part of "idle". */
const CLAUDE_BUSY = /esc to interrupt/i;

/**
 * The input box prompt.
 *
 * Anchored without a trailing space on purpose: an empty box renders as a
 * bare "❯", and trailing whitespace is stripped when the screen is read, so
 * requiring "❯ " never matches an idle box.
 */
const CLAUDE_INPUT = /^❯/m;

/** First-run dialog that blocks input until the directory is trusted. */
const CLAUDE_TRUST = /Is this a project you created or one you trust/i;

/**
 * The status bar, e.g. "● high · /effort". It opens with the same bullet
 * glyph that marks an assistant reply, so reply detection has to exclude it.
 */
const CLAUDE_STATUS_BAR = /^●\s+\w+\s+·\s+\/\w+/;

/**
 * Flags that reduce the session to a plain text generator.
 *
 * Abjects routes every capability through its own objects on the message
 * bus, so the CLI's own tool layer is not just unnecessary here, it is
 * actively harmful: left enabled the model sees a catalog of built-in tools
 * and whatever MCP servers the user has configured, and reaches for them on
 * any task that mentions email, files, or the web. Those calls either fail
 * ("permission not granted") or bypass the Abject that should have handled
 * the work.
 *
 * - `--tools ""` disables every built-in tool (Bash, Read, Edit, Web*).
 * - `--strict-mcp-config` ignores user- and project-level MCP servers;
 *   paired with no `--mcp-config`, that means no MCP at all.
 * - `--permission-mode dontAsk` is the safety net that matters most for an
 *   unattended session: a permission prompt has no one to answer it, so it
 *   would hold the turn open until the idle timeout killed the session.
 *   Denying is recoverable, blocking is not.
 * - `--safe-mode` drops CLAUDE.md, skills, plugins, and hooks. Without it
 *   the working directory's CLAUDE.md is loaded into every single request.
 *   Auth is explicitly unaffected by this flag, so subscription sessions
 *   keep working.
 *
 * `--disable-slash-commands` is deliberately NOT here: it also disables
 * `/clear`, which is how context gets reset between requests.
 */
const CLAUDE_HARDENING = [
  '--tools', '',
  '--strict-mcp-config',
  '--permission-mode', 'dontAsk',
  '--safe-mode',
] as const;

export const claudeDialect: PtyDialect = {
  id: 'claude-pty',
  bin: 'claude',
  argv: CLAUDE_HARDENING,
  cols: COLS,
  rows: ROWS,

  isReady(screen) {
    return CLAUDE_INPUT.test(screen) && RULE.test(screen) && !CLAUDE_BUSY.test(screen);
  },

  dismissKeys(screen) {
    // "1. Yes, I trust this folder" is preselected and the dialog's own
    // footer says "Enter to confirm", so Enter takes the safe branch.
    if (CLAUDE_TRUST.test(screen)) return ['\r'];
    return undefined;
  },

  clearCommand: '/clear',

  isTurnComplete(screen) {
    return !CLAUDE_BUSY.test(screen) && CLAUDE_TURN_DONE.test(screen);
  },

  isIdle(screen) {
    return CLAUDE_INPUT.test(screen) && !CLAUDE_BUSY.test(screen);
  },

  isBusy(screen) {
    return CLAUDE_BUSY.test(screen);
  },

  isChrome(line) {
    const t = line.trim();
    if (t === '') return false;                       // blank lines are content spacing
    if (RULE.test(t)) return true;                    // input box rules
    if (/^[╭╰│╮╯]/.test(t)) return true;              // welcome/banner box borders
    if (/^[⚠✻✽✢✳✶]/.test(t)) return true;             // warnings and the spinner line
    if (/^❯/.test(t)) return true;                    // echoed input
    if (/^⏸/.test(t)) return true;                    // mode hint footer
    if (CLAUDE_STATUS_BAR.test(t)) return true;
    if (CLAUDE_TURN_DONE.test(t)) return true;
    return false;
  },

  // Assistant turns are bulleted "● ". The status bar uses the same glyph,
  // so it has to be excluded explicitly.
  isReplyStart(line) {
    const t = line.trimStart();
    return t.startsWith('●') && !CLAUDE_STATUS_BAR.test(t);
  },

  env(base) {
    // A session launched from inside Claude Code inherits markers that make
    // the child believe it is a nested run, which silently changes its
    // behaviour (observed: transcript persistence turned off).
    return scrubAgentEnv(base, ['CLAUDE_CODE_']);
  },
};

// ── Codex ──────────────────────────────────────────────────────────────

/** Codex prints no end-of-turn marker, so idleness carries the detection. */
const CODEX_INPUT = /^›/m;

/**
 * The working indicator, e.g. "• Working (2s • esc to interrupt)" or
 * "• Booting MCP server: codex_apps (0s • esc to interrupt)".
 *
 * Note it opens with the same bullet that marks an assistant reply, so
 * reply detection has to exclude it or the spinner gets harvested as the
 * model's answer.
 */
const CODEX_WORKING_LINE = /^•.*\besc to interrupt\b/i;
const CODEX_BUSY = /esc to interrupt/i;

/**
 * Startup dialog offering to self-update. It blocks input until answered,
 * and its first option runs an install, so it must be answered explicitly
 * rather than with a bare Enter.
 *
 * Matched on "Skip until next version", which is unique to the interactive
 * menu. The obvious choice, "Update available!", also appears in a purely
 * informational banner box that stays on screen for the whole session, so
 * using it here would mean the UI never looked ready.
 */
const CODEX_UPDATE_DIALOG = /Skip until next version/i;


/**
 * Codex equivalent of {@link CLAUDE_HARDENING}.
 *
 * Codex has no "disable all tools" switch, so the tools are contained
 * rather than removed:
 *
 * - `--sandbox read-only` stops the session touching the filesystem.
 * - `--ask-for-approval never` is the counterpart to claude's `dontAsk`:
 *   an approval prompt in an unattended session would hold the turn open
 *   until the idle timeout. Execution failures come back to the model
 *   instead, which is recoverable.
 * - `-c mcp_servers={}` clears configured MCP servers. Observed without
 *   it: "Booting MCP server: codex_apps" on every session start, which
 *   both slows startup and hands the model tools Abjects should own.
 */
const CODEX_HARDENING = [] as const;

/*
 * UNRESOLVED - codex hardening is currently empty, and that is a known gap
 * rather than an oversight.
 *
 * What was tried: `--sandbox read-only`, `--ask-for-approval never`,
 * `-c mcp_servers={}`, and `--disable` for unified_exec / browser_use /
 * computer_use / apps / image_generation. All are accepted by the binary.
 *
 * Two findings stopped it going in:
 *
 * 1. None of them actually removes tool access. Probed with an unguessable
 *    token written to a file: codex read the file and returned the token
 *    with every one of those flags set. Unlike claude, codex has no way to
 *    run as a plain text generator; `--sandbox read-only` restricts writes,
 *    not reads or command execution.
 *
 * 2. With those flags, sessions began exiting on their own with code 0,
 *    intermittently, sometimes before a single keystroke was sent. The
 *    flakiness was NOT caused by the flags (a no-flag control failed the
 *    same way one run in two), so the real cause is still unidentified and
 *    adding unverified flags on top only obscured it.
 *
 * Consequence for callers: a codex session can read the filesystem and run
 * commands. The session's working directory is an empty per-session
 * sandbox, which limits what is reachable by relative path but does not
 * stop an absolute one. Treat codex-cli as a provider with tool access.
 */

export const codexDialect: PtyDialect = {
  id: 'codex-pty',
  bin: 'codex',
  argv: CODEX_HARDENING,
  cols: COLS,
  rows: ROWS,

  isReady(screen) {
    return CODEX_INPUT.test(screen) && !CODEX_BUSY.test(screen) && !CODEX_UPDATE_DIALOG.test(screen);
  },

  dismissKeys() {
    // Deliberately answers nothing. See blockedReason() below.
    return undefined;
  },

  /**
   * The update prompt is "1. Update now / 2. Skip / 3. Skip until next
   * version" with option 1 preselected, and option 1 runs
   * `npm install -g @openai/codex`.
   *
   * Answering it by sending Down then Enter was tried and abandoned. It
   * works in isolation but not reliably in a session: the prompt can appear
   * at any time, not only at startup, so the keystrokes sometimes arrive
   * while the menu is still repainting and the Enter lands on "Update now".
   * The observed result is codex reinstalling itself and the session dying
   * with exit code 0, intermittently. No amount of extra settling made that
   * safe, and the downside of losing the coin flip is modifying the user's
   * global npm packages as a side effect of an LLM request.
   */
  blockedReason(screen) {
    if (!CODEX_UPDATE_DIALOG.test(screen)) return undefined;
    return 'codex is waiting on its update prompt, which cannot be answered safely '
      + 'from an automated session (one option runs `npm install -g @openai/codex`). '
      + 'Run `codex` once in a terminal and choose "Skip until next version", or update codex.';
  },

  // Verified to drop prior context: after /new, a question about a number
  // given before it came back "UNKNOWN".
  clearCommand: '/new',

  isTurnComplete() {
    // Codex prints nothing at the end of a turn; PtySession falls back to
    // the reply terminator and to isIdle() plus a pause in output.
    return false;
  },

  isIdle(screen) {
    return CODEX_INPUT.test(screen) && !CODEX_BUSY.test(screen);
  },

  isChrome(line) {
    const t = line.trim();
    if (t === '') return false;
    if (RULE.test(t)) return true;
    if (/^[╭╰│╮╯]/.test(t)) return true;              // banner boxes
    if (/^›/.test(t)) return true;                    // echoed input and placeholder hint
    if (CODEX_WORKING_LINE.test(t)) return true;      // spinner, shares the reply bullet
    if (/^Tip:/i.test(t)) return true;                // rotating footer tips
    if (/^Token usage:/i.test(t)) return true;        // printed after /new
    if (/^To continue this session, run codex resume/i.test(t)) return true;
    if (/·\s*~?\//.test(t) && /\b(xhigh|high|medium|low|fast)\b/.test(t)) return true; // status bar
    return false;
  },

  // Assistant turns are bulleted "• " (U+2022), distinct from the "›" that
  // marks echoed input. The working indicator uses the same bullet, so it
  // is excluded explicitly.
  isReplyStart(line) {
    const t = line.trimStart();
    return t.startsWith('•') && !CODEX_WORKING_LINE.test(t);
  },

  isBusy(screen) {
    return CODEX_BUSY.test(screen);
  },

  env(base) {
    return scrubAgentEnv(base, ['CODEX_']);
  },
};
