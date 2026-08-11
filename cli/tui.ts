/**
 * Minimal hand-rolled ANSI terminal UI for commune: alternate screen with a
 * scrollable message area, a tmux-style tab bar, and an editable input line.
 *
 * Deliberately avoids every key chord tmux or screen intercepts: navigation
 * is Alt-based (terminals forward Alt as ESC-prefixed sequences, which tmux
 * passes through untouched), with slash commands as the universal fallback.
 */

// ── Key parsing ────────────────────────────────────────────────────────

export type Key =
  | { type: 'char'; ch: string }
  | { type: 'enter' }
  | { type: 'backspace' }
  | { type: 'delete' }
  | { type: 'left' } | { type: 'right' } | { type: 'up' } | { type: 'down' }
  | { type: 'home' } | { type: 'end' }
  | { type: 'pageup' } | { type: 'pagedown' }
  | { type: 'ctrl'; ch: string }
  | { type: 'alt'; ch: string }
  | { type: 'altleft' } | { type: 'altright' }
  | { type: 'esc' };

/** Parse a raw stdin chunk into key events. */
export function parseKeys(buf: Buffer): Key[] {
  const keys: Key[] = [];
  const s = buf.toString('utf8');
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\x1b') {
      const rest = s.slice(i);
      // CSI sequences
      const csi = /^\x1b\[([0-9;]*)([A-Za-z~])/.exec(rest);
      if (csi) {
        const [full, params, final] = [csi[0], csi[1], csi[2]];
        i += full.length;
        keys.push(...csiKey(params, final));
        continue;
      }
      // Alt+char arrives as ESC followed by the char
      const next = s[i + 1];
      if (next !== undefined && next !== '\x1b' && next >= ' ') {
        keys.push({ type: 'alt', ch: next.toLowerCase() });
        i += 2;
        continue;
      }
      keys.push({ type: 'esc' });
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') { keys.push({ type: 'enter' }); i++; continue; }
    if (ch === '\x7f' || ch === '\b') { keys.push({ type: 'backspace' }); i++; continue; }
    if (ch < ' ') {
      // Ctrl+letter: 0x01..0x1a
      const code = ch.charCodeAt(0);
      if (code >= 1 && code <= 26) {
        keys.push({ type: 'ctrl', ch: String.fromCharCode(96 + code) });
      }
      i++;
      continue;
    }
    keys.push({ type: 'char', ch });
    i++;
  }
  return keys;
}

function csiKey(params: string, final: string): Key[] {
  const alt = params.startsWith('1;3') || params.startsWith('1;9');
  switch (final) {
    case 'A': return [{ type: 'up' }];
    case 'B': return [{ type: 'down' }];
    case 'C': return [alt ? { type: 'altright' } : { type: 'right' }];
    case 'D': return [alt ? { type: 'altleft' } : { type: 'left' }];
    case 'H': return [{ type: 'home' }];
    case 'F': return [{ type: 'end' }];
    case '~':
      switch (params.split(';')[0]) {
        case '1': case '7': return [{ type: 'home' }];
        case '3': return [{ type: 'delete' }];
        case '4': case '8': return [{ type: 'end' }];
        case '5': return [{ type: 'pageup' }];
        case '6': return [{ type: 'pagedown' }];
      }
      return [];
    default: return [];
  }
}

// ── Rendering ──────────────────────────────────────────────────────────

export type LineColor = 'normal' | 'dim' | 'bold' | 'cyan' | 'green' | 'yellow' | 'red';

export interface Line {
  text: string;
  color: LineColor;
}

export interface TabInfo {
  label: string;
  active: boolean;
  unread: boolean;
  busy: boolean;
}

export interface ScreenModel {
  tabs: TabInfo[];
  lines: Line[];
  /** Wrapped-line offset from the bottom; 0 = pinned to newest. */
  scrollOffset: number;
  input: string;
  cursor: number;
  status?: string;
  /** Transient toast text shown as an overlay bar on the top row. */
  toast?: string;
}

const COLOR_CODES: Record<LineColor, string> = {
  normal: '',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};
const RESET = '\x1b[0m';
const INVERSE = '\x1b[7m';

/** Track SGR codes that are currently active, for re-applying after a wrap. */
function updateSgrState(active: string[], params: string): void {
  const parts = (params || '0').split(';');
  for (let i = 0; i < parts.length; i++) {
    const n = parts[i] === '' ? 0 : parseInt(parts[i], 10);
    // Extended colors (38/48;2;r;g;b or 38/48;5;n) are one atomic sequence.
    if (n === 38 || n === 48) {
      const take = parts[i + 1] === '2' ? 5 : parts[i + 1] === '5' ? 3 : 1;
      (n === 38 ? removeFg : removeBg)(active);
      active.push(`\x1b[${parts.slice(i, i + take).join(';')}m`);
      i += take - 1;
      continue;
    }
    if (n === 0) { active.length = 0; continue; }
    if (n === 22) { removeSgr(active, [1, 2]); continue; }
    if (n === 23) { removeSgr(active, [3]); continue; }
    if (n === 39) { removeFg(active); continue; }
    if (n === 49) { removeBg(active); continue; }
    active.push(`\x1b[${n}m`);
  }
}

function removeFg(active: string[]): void {
  removeSgr(active, range(30, 38).concat(range(90, 97)));
  removePrefixed(active, '\x1b[38;');
}

function removeBg(active: string[]): void {
  removeSgr(active, range(40, 48).concat(range(100, 107)));
  removePrefixed(active, '\x1b[48;');
}

function removePrefixed(active: string[], prefix: string): void {
  for (let i = active.length - 1; i >= 0; i--) {
    if (active[i].startsWith(prefix)) active.splice(i, 1);
  }
}

function removeSgr(active: string[], codes: number[]): void {
  for (const n of codes) {
    const seq = `\x1b[${n}m`;
    let i;
    while ((i = active.indexOf(seq)) >= 0) active.splice(i, 1);
  }
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= to; n++) out.push(n);
  return out;
}

/**
 * Wrap text to `width` visible columns, ANSI-aware: SGR escape sequences are
 * zero-width, never split, and re-applied at the start of continuation rows.
 */
export function wrapAnsi(text: string, width: number): string[] {
  const rows: string[] = [];
  const active: string[] = [];
  let row = '';
  let visible = 0;
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\x1b') {
      const m = /^\x1b\[([0-9;]*)m/.exec(text.slice(i));
      if (m) {
        row += m[0];
        updateSgrState(active, m[1]);
        i += m[0].length;
        continue;
      }
    }
    row += text[i];
    visible++;
    i++;
    if (visible >= width && i < text.length) {
      rows.push(row);
      row = active.join('');
      visible = 0;
    }
  }
  rows.push(row);
  return rows;
}

export class Screen {
  private active = false;

  get rows(): number { return process.stdout.rows || 24; }
  get cols(): number { return process.stdout.columns || 80; }
  get contentRows(): number { return Math.max(1, this.rows - 2); }

  enter(): void {
    if (this.active) return;
    this.active = true;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdout.write('\x1b[?1049h\x1b[?25l');
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    process.stdout.write('\x1b[?25h\x1b[?1049l');
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
  }

  /** Wrap a line's text to the terminal width, ANSI-aware. */
  private wrap(text: string): string[] {
    return wrapAnsi(text, Math.max(8, this.cols));
  }

  render(model: ScreenModel): void {
    if (!this.active) return;
    const width = this.cols;
    const toastRows = model.toast ? 1 : 0;
    const contentRows = this.contentRows - toastRows;

    // Wrap from the end backwards until we have enough rows to fill the
    // viewport plus the scroll offset; older lines never need wrapping.
    const needed = contentRows + model.scrollOffset;
    const wrapped: Array<{ text: string; color: LineColor }> = [];
    for (let i = model.lines.length - 1; i >= 0 && wrapped.length < needed; i--) {
      const line = model.lines[i];
      const rows = this.wrap(line.text);
      for (let r = rows.length - 1; r >= 0; r--) {
        wrapped.unshift({ text: rows[r], color: line.color });
        if (wrapped.length >= needed) break;
      }
    }
    const end = Math.max(0, wrapped.length - model.scrollOffset);
    const visible = wrapped.slice(Math.max(0, end - contentRows), end);

    const out: string[] = [];
    out.push('\x1b[H');
    if (model.toast) {
      const text = ` ${model.toast} `.slice(0, width);
      out.push('\x1b[2K\x1b[7;33m' + text + ' '.repeat(Math.max(0, width - text.length)) + RESET + '\r\n');
    }
    for (let row = 0; row < contentRows; row++) {
      const line = visible[row - (contentRows - visible.length)];
      out.push('\x1b[2K');
      if (line) {
        // Rows from wrap() are already width-bounded; always reset so inline
        // SGR styling never bleeds into the next row.
        out.push(COLOR_CODES[line.color] + line.text + RESET);
      }
      out.push('\r\n');
    }

    // Tab bar (inverse video row)
    out.push('\x1b[2K');
    out.push(INVERSE + this.tabBar(model, width) + RESET + '\r\n');

    // Input line (window the tail if it overflows)
    const prompt = '> ';
    const avail = Math.max(8, width - prompt.length - 1);
    let inputView = model.input;
    let cursorInView = model.cursor;
    if (cursorInView > avail) {
      inputView = model.input.slice(cursorInView - avail, cursorInView);
      cursorInView = avail;
    }
    inputView = inputView.slice(0, avail);
    out.push('\x1b[2K' + prompt + inputView);

    // Park the cursor at the input position
    out.push(`\x1b[${this.rows};${prompt.length + cursorInView + 1}H\x1b[?25h`);
    process.stdout.write(out.join(''));
  }

  private tabBar(model: ScreenModel, width: number): string {
    const parts: string[] = [];
    model.tabs.forEach((tab, i) => {
      const marks = `${tab.busy ? '~' : ''}${tab.unread ? '!' : ''}`;
      const body = ` ${i + 1}:${tab.label}${marks} `;
      parts.push(tab.active ? `\x1b[1m[${body.trim()}]\x1b[22m` : body);
    });
    let bar = parts.join('');
    if (model.status) {
      const plainLen = bar.replace(/\x1b\[[0-9;]*m/g, '').length;
      const pad = width - plainLen - model.status.length - 1;
      bar += ' '.repeat(Math.max(1, pad)) + model.status;
    }
    // Trim on plain length so ANSI codes don't count against the width
    let plain = 0; let cut = bar.length;
    for (let i = 0; i < bar.length; i++) {
      if (bar[i] === '\x1b') {
        const m = /^\x1b\[[0-9;]*m/.exec(bar.slice(i));
        if (m) { i += m[0].length - 1; continue; }
      }
      plain++;
      if (plain >= width) { cut = i + 1; break; }
    }
    bar = bar.slice(0, cut);
    const plainLen = bar.replace(/\x1b\[[0-9;]*m/g, '').length;
    return bar + ' '.repeat(Math.max(0, width - plainLen));
  }
}
