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

// Codex uses structured execution (codex-cli.ts). A terminal transcript cannot
// distinguish native execution from the final Abject response.
