/**
 * commune -- terminal client for the Abjects CLI gateway (CliServer, :7723).
 *
 *   pnpm commune              tabbed TUI (Alt-key navigation, tmux-safe)
 *   pnpm commune --plain      line-oriented REPL (dumb terminals, pipes)
 *   pnpm commune --url ws://host:7723
 *
 * Auth mirrors the browser client: when the server has ABJECTS_AUTH_USER /
 * ABJECTS_AUTH_PASSWORD set, commune prompts (or uses those same env vars)
 * and caches the 7-day session token in ~/.config/abjects/commune.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as readline from 'node:readline';
import {
  CommuneClient, Credentials, PushedEvent, WorkspaceRow, ConversationRow, MessageEvent, DialogInfo, GoalTask,
} from './client.js';
import { Screen, parseKeys, Key, Line, LineColor, TabInfo } from './tui.js';
import { renderMarkdown, stripAnsi } from './markdown.js';

function helpLines(p: string): string[] {
  const P = `C-${p}`;
  return [
    'commands:',
    '  /new [title]      new chat in this tab\'s workspace (opens a tab)',
    '  /open             pick a workspace and chat to open in a new tab',
    '  /tabs             list open tabs',
    `  /tab N|next|prev  switch tab        (also ${P} 1..9, ${P} n/p, ${P} arrows)`,
    `  /close            close this tab    (also ${P} x; chat keeps running)`,
    '  /rename <title>   rename this conversation',
    '  /delete           delete this conversation and close the tab',
    '  /history          re-fetch this conversation\'s transcript',
    '  /stop /pause /resume   control the running goal',
    '  /ws               list workspaces',
    '  /ws <n|name>      set the active workspace (what the desktop shows)',
    '  /ws new <name>    create a workspace',
    `  /quit             exit             (also ${P} d, or double Ctrl+C)`,
    `anything else is sent to the active chat. ${P} c opens the chat picker,`,
    `${P} ${P} jumps to line start. Set COMMUNE_PREFIX=ctrl+x (etc.) to change the prefix.`,
    'desktop dialogs appear here too: y/n or Enter/Esc answers them, and prompts',
    'type into the input line. Toasts show briefly in the top bar.',
  ];
}

/** Parse COMMUNE_PREFIX ("ctrl+a", "C-x", "^b") down to its letter; default 'a'. */
function parsePrefixKey(spec?: string): string {
  const m = /(?:ctrl\+|c-|\^)?([a-z])$/i.exec((spec ?? '').trim());
  const ch = m ? m[1].toLowerCase() : 'a';
  return ch === 'c' ? 'a' : ch; // Ctrl+C is reserved for quit
}

// ── Config / token cache ───────────────────────────────────────────────

const CONFIG_PATH = path.join(os.homedir(), '.config', 'abjects', 'commune.json');

interface CommuneConfig { tokens: Record<string, string> }

function loadConfig(): CommuneConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    return { tokens: parsed.tokens ?? {} };
  } catch {
    return { tokens: {} };
  }
}

function saveToken(url: string, token: string): void {
  const config = loadConfig();
  config.tokens[url] = token;
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
  } catch { /* cache is best-effort */ }
}

// ── Plain-terminal prompts (used before the TUI takes the screen) ──────

function promptLine(question: string, mask: boolean): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(question);
    const wasRaw = process.stdin.isRaw;
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    let value = '';
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.off('data', onData);
          if (!wasRaw) process.stdin.setRawMode?.(false);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\x03') {
          process.stdout.write('\n');
          process.exit(1);
        }
        if (ch === '\x7f' || ch === '\b') {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (!mask) process.stdout.write('\b \b');
          }
          continue;
        }
        if (ch >= ' ') {
          value += ch;
          process.stdout.write(mask ? '*' : ch);
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

function makeCredentialProvider(url: string): (attempt: number, error?: string) => Promise<Credentials | null> {
  return async (attempt, error) => {
    if (attempt === 0) {
      const cached = loadConfig().tokens[url];
      if (cached) return { token: cached };
    }
    const envUser = process.env.ABJECTS_AUTH_USER;
    const envPass = process.env.ABJECTS_AUTH_PASSWORD;
    if (envUser && envPass && attempt <= 1) {
      return { username: envUser, password: envPass };
    }
    if (!process.stdin.isTTY) return null;
    if (attempt >= 4) return null;
    if (error && attempt > 1) process.stdout.write(`${error}\n`);
    const username = await promptLine('username: ', false);
    const password = await promptLine('password: ', true);
    return { username, password };
  };
}

// ── Shared formatting ──────────────────────────────────────────────────

function formatMessage(role: string, sender: string, text: string, markdown = false): Line[] {
  const color: LineColor =
    role === 'user' ? 'cyan' :
    role === 'error' ? 'red' :
    role === 'system' ? 'dim' : 'normal';
  const prefix = `${sender || role}: `;
  if (markdown) {
    return renderMarkdown(text).map((line, i) => ({
      text: (i === 0 ? prefix : '  ') + line.text,
      color: line.dim ? 'dim' : color,
    }));
  }
  return text.split('\n').map((line, i) => ({
    text: i === 0 ? prefix + line : '  ' + line,
    color,
  }));
}

/** Agents write markdown; user/system/error text renders literally. */
function isMarkdownMessage(role: string, markdownFlag?: unknown): boolean {
  return role === 'assistant' || markdownFlag === true;
}

function formatGoal(data: Record<string, unknown>): { line: Line | null; busy: boolean | null } {
  const aspect = String(data.aspect ?? '');
  const clip = (v: unknown, n = 200) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);
  switch (aspect) {
    case 'goalCreated':
      return { line: { text: `· goal started: ${clip(data.title, 120)}`, color: 'dim' }, busy: true };
    case 'goalUpdated': {
      const message = clip(data.message, 160);
      return { line: message ? { text: `· ${message}`, color: 'dim' } : null, busy: true };
    }
    case 'scrumPlanned':
      return { line: { text: '· plan ready, working…', color: 'dim' }, busy: true };
    case 'goalCompleted':
      return { line: { text: '· goal completed', color: 'green' }, busy: false };
    case 'goalFailed':
      return { line: { text: `· goal failed: ${clip(data.error, 160)}`, color: 'red' }, busy: false };
    case 'goalPaused':
      return { line: { text: '· goal paused', color: 'yellow' }, busy: null };
    case 'goalResumed':
      return { line: { text: '· goal resumed', color: 'dim' }, busy: true };
    case 'goalClarificationRequested':
      return { line: { text: `? ${clip(data.question, 500)} (type to answer)`, color: 'yellow' }, busy: null };
    default:
      return { line: null, busy: null };
  }
}

// ── Tabbed TUI ─────────────────────────────────────────────────────────

interface Tab {
  workspaceId: string;
  wsName: string;
  conversationId: string;
  title: string;
  lines: Line[];
  scroll: number;
  unread: boolean;
  busy: boolean;
  /**
   * The running goal's live panel — the terminal counterpart of the visual
   * chat's goal tree. Rendered under the transcript while a goal runs:
   * title, task list with statuses, and a mutating activity line. Durable
   * milestones (goal started/completed/failed) go into `lines`; everything
   * else only mutates this.
   */
  goal?: {
    goalId: string;
    title: string;
    description?: string;
    activity?: string;
    tasks: GoalTask[];
    refreshTimer?: ReturnType<typeof setTimeout>;
  };
}

type Mode =
  | { kind: 'normal' }
  | { kind: 'pickWorkspace'; items: WorkspaceRow[] }
  | { kind: 'pickChat'; ws: WorkspaceRow; items: ConversationRow[] };

const MAX_TAB_LINES = 2000;

class TuiApp {
  private client: CommuneClient;
  private screen = new Screen();
  private tabs: Tab[] = [];
  private active = 0;
  private mode: Mode = { kind: 'normal' };
  private input = '';
  private cursor = 0;
  private status = '';
  private ctrlCArmed = false;
  private quitting = false;
  private url: string;
  private wsNames = new Map<string, string>();
  private pendingOpens = new Set<string>();
  private prefixKey = parsePrefixKey(process.env.COMMUNE_PREFIX);
  private prefixArmed = false;
  private prefixTimer?: ReturnType<typeof setTimeout>;
  private dialogQueue: DialogInfo[] = [];
  private stashedInput?: { input: string; cursor: number };
  private toastQueue: string[] = [];
  private currentToast?: string;
  private toastTimer?: ReturnType<typeof setTimeout>;

  constructor(url: string) {
    this.url = url;
    this.client = new CommuneClient({
      url,
      getCredentials: makeCredentialProvider(url),
      onToken: (token) => saveToken(url, token),
      onEvent: (event) => this.handleEvent(event),
      onClose: (reason) => this.handleDisconnect(reason),
    });
  }

  async run(): Promise<void> {
    await this.client.connect();

    // Mirror the desktop: one tab per chat whose window is currently open,
    // across every workspace (active workspace's tabs first). If nothing is
    // open anywhere, fall back to the most recent chat in the active
    // workspace, or create one.
    const workspaces = await this.workspaces();
    if (workspaces.length === 0) throw new Error('No workspaces available');
    const active = workspaces.find(w => w.active) ?? workspaces[0];
    const ordered = [active, ...workspaces.filter(w => w !== active)];
    for (const ws of ordered) {
      const chats = await this.client.listChats(ws.id).catch(() => []);
      for (const chat of chats.filter(c => c.open)) {
        await this.openTab(ws, chat.conversationId).catch(() => { /* skip broken chat */ });
      }
    }
    if (this.tabs.length === 0) {
      const chats = await this.client.listChats(active.id);
      if (chats.length > 0) await this.openTab(active, chats[0].conversationId);
      else await this.openTab(active);
    }
    this.active = 0;

    this.screen.enter();
    process.stdin.on('data', (buf: Buffer) => {
      for (const key of parseKeys(buf)) this.handleKey(key);
    });
    process.stdout.on('resize', () => this.render());
    this.render();
    await new Promise(() => { /* runs until quit() calls process.exit */ });
  }

  private quit(): void {
    this.quitting = true;
    this.screen.exit();
    this.client.close();
    process.exit(0);
  }

  // ── Tabs ─────────────────────────────────────────────────────────────

  private tab(): Tab | undefined {
    return this.tabs[this.active];
  }

  private hasTab(workspaceId: string, conversationId: string): boolean {
    return this.tabs.some(t => t.workspaceId === workspaceId && t.conversationId === conversationId);
  }

  /** listWorkspaces that also refreshes the id -> name map used for tab labels. */
  private async workspaces(): Promise<WorkspaceRow[]> {
    const list = await this.client.listWorkspaces();
    for (const w of list) this.wsNames.set(w.id, w.name);
    return list;
  }

  private async openTab(
    ws: WorkspaceRow | { id: string; name: string },
    conversationId?: string,
    title?: string,
    opts: { focus?: boolean } = {},
  ): Promise<void> {
    const focus = opts.focus !== false;
    // Guard against a concurrent open of the same conversation (e.g. our own
    // /new racing the conversationOpened event it triggers).
    let key = conversationId ? `${ws.id}:${conversationId}` : undefined;
    if (key) {
      if (this.pendingOpens.has(key)) return;
      this.pendingOpens.add(key);
    }
    try {
      const opened = conversationId
        ? await this.client.openChat(ws.id, conversationId)
        : await this.client.newChat(ws.id, title);
      if (!key) {
        key = `${ws.id}:${opened.conversationId}`;
        this.pendingOpens.add(key);
      }

      const existing = this.tabs.findIndex(
        t => t.workspaceId === ws.id && t.conversationId === opened.conversationId);
      if (existing >= 0) {
        if (focus) this.active = existing;
        this.render();
        return;
      }

      const chats = await this.client.listChats(ws.id);
      const row = chats.find(c => c.conversationId === opened.conversationId);
      const tab: Tab = {
        workspaceId: ws.id,
        wsName: ws.name,
        conversationId: opened.conversationId,
        title: row?.title ?? title ?? 'chat',
        lines: [],
        scroll: 0,
        unread: !focus,
        busy: false,
      };
      await this.loadHistory(tab);
      this.tabs.push(tab);
      if (focus) this.active = this.tabs.length - 1;
      this.render();
    } finally {
      if (key) this.pendingOpens.delete(key);
    }
  }

  private async loadHistory(tab: Tab): Promise<void> {
    tab.lines = [];
    try {
      const history = await this.client.history(tab.workspaceId, tab.conversationId);
      for (const entry of history) {
        tab.lines.push(...formatMessage(entry.role, entry.sender ?? entry.role, entry.content,
          isMarkdownMessage(entry.role)));
      }
      if (history.length > 0) {
        tab.lines.push({ text: '── live ──', color: 'dim' });
      }
    } catch (err) {
      tab.lines.push({ text: `failed to load history: ${String(err)}`, color: 'red' });
    }
  }

  private closeTab(index: number): void {
    const tab = this.tabs[index];
    if (!tab) return;
    this.clearGoal(tab);
    void this.client.closeChat(tab.workspaceId, tab.conversationId).catch(() => { /* best effort */ });
    this.tabs.splice(index, 1);
    if (this.tabs.length === 0) {
      void this.startPicker();
      return;
    }
    if (this.active >= this.tabs.length) this.active = this.tabs.length - 1;
    this.render();
  }

  private appendTo(tab: Tab, lines: Line[]): void {
    tab.lines.push(...lines);
    if (tab.lines.length > MAX_TAB_LINES) {
      tab.lines.splice(0, tab.lines.length - MAX_TAB_LINES);
    }
    if (tab !== this.tab()) tab.unread = true;
  }

  private note(text: string, color: LineColor = 'dim'): void {
    const tab = this.tab();
    if (tab) this.appendTo(tab, [{ text, color }]);
    this.render();
  }

  // ── Events from the server ───────────────────────────────────────────

  private handleEvent(event: PushedEvent): void {
    if (this.quitting) return;
    switch (event.event) {
      case 'message': {
        const data = event.data as unknown as MessageEvent;
        const tab = this.tabs.find(
          t => t.workspaceId === event.workspaceId && t.conversationId === event.conversationId);
        if (!tab) return;
        this.appendTo(tab, formatMessage(data.role, data.sender, data.text,
          isMarkdownMessage(data.role, data.markdown)));
        break;
      }
      case 'goalProgress': {
        const data = event.data;
        const aspect = String(data.aspect ?? '');
        const goalId = String(data.goalId ?? '');
        const clip = (v: unknown, n: number) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n);
        for (const tab of this.tabs) {
          if (tab.workspaceId !== event.workspaceId) continue;
          switch (aspect) {
            case 'goalCreated':
              // Sub-goals (parentId set) stay inside the root goal's panel.
              if (data.parentId || (tab.goal && tab.goal.goalId !== goalId)) break;
              this.appendTo(tab, [{ text: `· goal started: ${clip(data.title, 120)}`, color: 'dim' }]);
              tab.goal = {
                goalId,
                title: clip(data.title, 120),
                description: clip(data.description, 600) || undefined,
                activity: 'planning…',
                tasks: [],
              };
              tab.busy = true;
              this.scheduleGoalRefresh(tab);
              break;
            case 'goalUpdated': {
              if (!tab.goal || tab.goal.goalId !== goalId) break;
              const message = clip(data.message, 160);
              const agent = typeof data.agentName === 'string' && data.agentName ? `[${data.agentName}] ` : '';
              if (message) tab.goal.activity = agent + message;
              tab.busy = true;
              break;
            }
            case 'scrumPlanned':
            case 'taskCompleted':
            case 'taskPermanentlyFailed':
            case 'taskUnblocked':
              if (!tab.goal || tab.goal.goalId !== goalId) break;
              tab.busy = true;
              this.scheduleGoalRefresh(tab);
              break;
            case 'goalCompleted':
              if (tab.goal && tab.goal.goalId !== goalId) break;
              this.appendTo(tab, [{ text: '· goal completed', color: 'green' }]);
              this.clearGoal(tab);
              break;
            case 'goalFailed':
              if (tab.goal && tab.goal.goalId !== goalId) break;
              this.appendTo(tab, [{ text: `· goal failed: ${clip(data.error, 160)}`, color: 'red' }]);
              this.clearGoal(tab);
              break;
            case 'goalPaused':
              if (tab.goal) tab.goal.activity = 'paused — type to interject, /resume to continue';
              break;
            case 'goalResumed':
              if (tab.goal) tab.goal.activity = 'working…';
              tab.busy = true;
              break;
            case 'goalInterjection':
              // A note (ours or the GUI's) reached the goal — acknowledge.
              if (tab.goal && tab.goal.goalId === goalId) {
                tab.goal.activity = 'note queued — the scrum master will weigh it';
              }
              break;
            case 'goalClarificationRequested':
              if (tab.goal && tab.goal.goalId !== goalId) break;
              this.appendTo(tab, [{ text: `? ${clip(data.question, 500)}`, color: 'yellow' }]);
              if (tab.goal) tab.goal.activity = 'waiting for your answer — type to reply';
              break;
          }
        }
        break;
      }
      case 'titleChanged':
      case 'conversationRenamed': {
        const { conversationId, title } = event.data as { conversationId: string; title: string };
        for (const tab of this.tabs) {
          if (tab.workspaceId === event.workspaceId && tab.conversationId === conversationId) {
            tab.title = title;
          }
        }
        break;
      }
      case 'conversationDeleted': {
        const { conversationId } = event.data as { conversationId: string };
        const index = this.tabs.findIndex(
          t => t.workspaceId === event.workspaceId && t.conversationId === conversationId);
        if (index >= 0) {
          this.appendTo(this.tabs[index], [{ text: 'conversation was deleted', color: 'red' }]);
        }
        break;
      }
      case 'toast': {
        const { message, level } = event.data as { message: string; level: string };
        const wsName = this.wsNames.get(event.workspaceId);
        const mark = level === 'error' ? 'x' : level === 'warn' ? '!' : '*';
        this.pushToast(`${mark} ${wsName ? `[${wsName}] ` : ''}${message}`);
        break;
      }
      case 'dialog': {
        this.dialogQueue.push(event.data as unknown as DialogInfo);
        if (this.dialogQueue.length === 1) this.activateDialog();
        break;
      }
      case 'dialogClosed': {
        const { dialogId } = event.data as { dialogId: string };
        const index = this.dialogQueue.findIndex(d => d.dialogId === dialogId);
        if (index === -1) break; // already answered here
        this.dialogQueue.splice(index, 1);
        if (index === 0) {
          this.pushToast('* dialog was answered elsewhere');
          this.deactivateDialog();
        }
        break;
      }
      case 'conversationOpened': {
        // A chat window opened somewhere (desktop or another terminal) —
        // mirror it as a background tab. The short delay lets an open we
        // initiated ourselves win the race and register its tab first.
        const { conversationId, title } = event.data as { conversationId: string; title: string };
        const key = `${event.workspaceId}:${conversationId}`;
        setTimeout(() => {
          if (this.quitting) return;
          if (this.hasTab(event.workspaceId, conversationId) || this.pendingOpens.has(key)) return;
          const name = this.wsNames.get(event.workspaceId) ?? event.workspaceId.slice(0, 8);
          void this.openTab({ id: event.workspaceId, name }, conversationId, title, { focus: false })
            .catch(() => { /* chat may have closed again already */ });
        }, 500);
        break;
      }
      default:
        return;
    }
    this.render();
  }

  private handleDisconnect(reason: string): void {
    if (this.quitting) return;
    this.status = 'reconnecting…';
    this.render();
    void this.reconnectLoop();
  }

  private async reconnectLoop(): Promise<void> {
    let delay = 1000;
    for (;;) {
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15000);
      try {
        await this.client.connect();
        for (const tab of this.tabs) {
          try { await this.client.openChat(tab.workspaceId, tab.conversationId); } catch { /* retried on send */ }
        }
        this.status = '';
        this.note('reconnected', 'green');
        return;
      } catch {
        this.status = 'reconnecting…';
        this.render();
      }
    }
  }

  // ── Goal panel ───────────────────────────────────────────────────────

  private clearGoal(tab: Tab): void {
    if (tab.goal?.refreshTimer) clearTimeout(tab.goal.refreshTimer);
    tab.goal = undefined;
    tab.busy = false;
  }

  /** Debounced fetch of the goal's task list (events just mark it stale). */
  private scheduleGoalRefresh(tab: Tab): void {
    const goal = tab.goal;
    if (!goal || goal.refreshTimer) return;
    goal.refreshTimer = setTimeout(() => {
      goal.refreshTimer = undefined;
      void this.client.goalStatus(tab.workspaceId, goal.goalId).then((status) => {
        if (!status || tab.goal !== goal) return;
        goal.title = status.title || goal.title;
        if (status.description) goal.description = status.description.replace(/\s+/g, ' ').slice(0, 600);
        goal.tasks = status.tasks;
        this.render();
      }).catch(() => { /* goal may be gone */ });
    }, 1000);
  }

  private goalPanelLines(tab: Tab): Line[] {
    const goal = tab.goal;
    if (!goal) return [];
    const lines: Line[] = [{ text: `▶ ${goal.title}`, color: 'yellow' }];
    if (goal.description && goal.description !== goal.title) {
      lines.push({ text: `   ⓘ ${goal.description}`, color: 'dim' });
    }
    for (const task of goal.tasks) {
      const description = task.description.replace(/\s+/g, ' ').slice(0, 140);
      const agent = task.agentName ? `  [${task.agentName}]` : '';
      switch (task.status) {
        case 'done':
          lines.push({ text: `   ✓ ${description}`, color: 'dim' });
          break;
        case 'failed':
        case 'permanently_failed':
          lines.push({ text: `   ✗ ${description}`, color: 'red' });
          break;
        case 'pending':
          lines.push({ text: `   ○ ${description}${agent}`, color: 'dim' });
          break;
        default: // claimed / in progress
          lines.push({ text: `   ▸ ${description}${agent}`, color: 'normal' });
          break;
      }
    }
    if (goal.activity) lines.push({ text: ` · ${goal.activity}`, color: 'dim' });
    return lines;
  }

  // ── Toasts ───────────────────────────────────────────────────────────

  private pushToast(text: string): void {
    this.toastQueue.push(text);
    if (!this.currentToast) this.advanceToast();
    else this.render();
  }

  private advanceToast(): void {
    if (this.toastTimer) { clearTimeout(this.toastTimer); this.toastTimer = undefined; }
    this.currentToast = this.toastQueue.shift();
    if (this.currentToast) {
      this.toastTimer = setTimeout(() => this.advanceToast(), 5000);
    }
    this.render();
  }

  // ── Dialogs ──────────────────────────────────────────────────────────

  /** The head of the dialog queue takes over the message area and input line. */
  private activateDialog(): void {
    const dialog = this.dialogQueue[0];
    if (!dialog) return;
    if (!this.stashedInput) this.stashedInput = { input: this.input, cursor: this.cursor };
    this.input = dialog.kind === 'prompt' ? (dialog.defaultValue ?? '') : '';
    this.cursor = this.input.length;
    this.render();
  }

  private deactivateDialog(): void {
    if (this.dialogQueue.length > 0) {
      this.activateDialog();
      return;
    }
    if (this.stashedInput) {
      this.input = this.stashedInput.input;
      this.cursor = this.stashedInput.cursor;
      this.stashedInput = undefined;
    }
    this.render();
  }

  private dialogLines(): Line[] {
    const dialog = this.dialogQueue[0]!;
    const lines: Line[] = [
      { text: `── ${dialog.title} ──`, color: dialog.destructive ? 'red' : 'yellow' },
      ...dialog.message.split('\n').map(t => ({ text: t, color: 'normal' as LineColor })),
    ];
    if (dialog.resource) {
      lines.push({ text: `  ${dialog.resource}`, color: 'yellow' });
    }
    lines.push({ text: '', color: 'normal' });
    if (dialog.kind === 'options' && dialog.options) {
      dialog.options.forEach((option, i) => {
        lines.push({ text: ` [${i + 1}] ${option.label}`, color: 'normal' });
      });
      lines.push({ text: 'press a number to choose, Esc denies', color: 'dim' });
    } else {
      const confirmLabel = dialog.confirmLabel ?? 'Confirm';
      const cancelLabel = dialog.cancelLabel ?? 'Cancel';
      lines.push(dialog.kind === 'prompt'
        ? { text: `type your answer below — [Enter] ${confirmLabel}   [Esc] ${cancelLabel}`, color: 'dim' }
        : { text: `[y/Enter] ${confirmLabel}   [n/Esc] ${cancelLabel}`, color: 'dim' });
    }
    if (this.dialogQueue.length > 1) {
      lines.push({ text: `(${this.dialogQueue.length - 1} more waiting)`, color: 'dim' });
    }
    return lines;
  }

  private handleDialogKey(key: Key): void {
    const dialog = this.dialogQueue[0];
    if (!dialog) return;
    const respond = (confirmed: boolean, value?: string, option?: string) => {
      this.dialogQueue.shift();
      void this.client.respondDialog(dialog.dialogId, confirmed, value, option)
        .catch(() => { /* already resolved elsewhere */ });
      this.deactivateDialog();
    };

    if (key.type === 'esc') { respond(false); return; }
    if (dialog.kind === 'options') {
      if (key.type === 'char') {
        const index = key.ch.charCodeAt(0) - '1'.charCodeAt(0);
        const option = dialog.options?.[index];
        if (option) respond(true, undefined, option.id);
      }
      return;
    }
    if (dialog.kind === 'confirm') {
      if (key.type === 'enter' || (key.type === 'char' && key.ch.toLowerCase() === 'y')) respond(true);
      else if (key.type === 'char' && key.ch.toLowerCase() === 'n') respond(false);
      return;
    }
    // Prompt: the input line is the dialog's text field.
    if (key.type === 'enter') { respond(true, this.input); return; }
    if (this.applyEditKey(key)) this.render();
  }

  // ── Keys ─────────────────────────────────────────────────────────────

  /** Shared input-line editing. Returns true if the key was consumed. */
  private applyEditKey(key: Key): boolean {
    switch (key.type) {
      case 'char':
        this.input = this.input.slice(0, this.cursor) + key.ch + this.input.slice(this.cursor);
        this.cursor++;
        return true;
      case 'backspace':
        if (this.cursor > 0) {
          this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
          this.cursor--;
        }
        return true;
      case 'delete':
        this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
        return true;
      case 'left': if (this.cursor > 0) this.cursor--; return true;
      case 'right': if (this.cursor < this.input.length) this.cursor++; return true;
      case 'home': this.cursor = 0; return true;
      case 'end': this.cursor = this.input.length; return true;
      case 'ctrl':
        if (key.ch === 'u') { this.input = this.input.slice(this.cursor); this.cursor = 0; return true; }
        if (key.ch === 'w') {
          const head = this.input.slice(0, this.cursor).replace(/\S+\s*$/, '');
          this.input = head + this.input.slice(this.cursor);
          this.cursor = head.length;
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  private handleKey(key: Key): void {
    if (key.type === 'ctrl' && key.ch === 'c') {
      if (this.ctrlCArmed) this.quit();
      this.ctrlCArmed = true;
      this.status = 'Ctrl+C again to quit';
      this.render();
      setTimeout(() => { this.ctrlCArmed = false; this.status = ''; this.render(); }, 2000);
      return;
    }

    // tmux-style chord: prefix (default Ctrl+A), then a command key.
    if (this.prefixArmed) {
      this.prefixArmed = false;
      if (this.prefixTimer) clearTimeout(this.prefixTimer);
      this.status = '';
      this.handleChord(key);
      this.render();
      return;
    }
    if (key.type === 'ctrl' && key.ch === this.prefixKey) {
      this.prefixArmed = true;
      this.status = `C-${this.prefixKey} …`;
      this.prefixTimer = setTimeout(() => {
        this.prefixArmed = false;
        this.status = '';
        this.render();
      }, 3000);
      this.render();
      return;
    }

    // A pending dialog owns the keys (and the input line for prompts).
    if (this.dialogQueue.length > 0) {
      this.handleDialogKey(key);
      return;
    }

    if (this.mode.kind !== 'normal') {
      this.handlePickerKey(key);
      return;
    }

    if (key.type === 'enter') {
      const text = this.input.trim();
      this.input = '';
      this.cursor = 0;
      if (text) void this.submit(text);
      this.render();
      return;
    }
    if (this.applyEditKey(key)) {
      this.render();
      return;
    }
    switch (key.type) {
      case 'up': this.scrollBy(1); break;
      case 'down': this.scrollBy(-1); break;
      case 'pageup': this.scrollBy(this.screen.contentRows - 1); break;
      case 'pagedown': this.scrollBy(-(this.screen.contentRows - 1)); break;
      case 'alt': this.handleAlt(key.ch); break;
      case 'altleft': this.cycleTab(-1); break;
      case 'altright': this.cycleTab(1); break;
      default: break;
    }
    this.render();
  }

  /** The command key pressed after the prefix. */
  private handleChord(key: Key): void {
    // Double prefix passes through as line-home (screen/tmux convention).
    if (key.type === 'ctrl' && key.ch === this.prefixKey) {
      this.cursor = 0;
      return;
    }
    if (key.type === 'left') { this.mode = { kind: 'normal' }; this.cycleTab(-1); return; }
    if (key.type === 'right') { this.mode = { kind: 'normal' }; this.cycleTab(1); return; }
    if (key.type !== 'char') return; // Esc or anything else cancels
    const ch = key.ch.toLowerCase();
    if (ch === 'd') { this.quit(); return; }
    if (ch !== 'c') this.mode = { kind: 'normal' }; // tab moves leave a picker
    this.handleAlt(ch);
  }

  private handleAlt(ch: string): void {
    if (ch >= '1' && ch <= '9') {
      const index = ch.charCodeAt(0) - '1'.charCodeAt(0);
      if (index < this.tabs.length) { this.active = index; this.tab()!.unread = false; }
      return;
    }
    switch (ch) {
      case 'c': void this.startPicker(); break;
      case 'n': this.cycleTab(1); break;
      case 'p': this.cycleTab(-1); break;
      case 'x': this.closeTab(this.active); break;
      case 'w': this.listTabs(); break;
    }
  }

  private cycleTab(delta: number): void {
    if (this.tabs.length === 0) return;
    this.active = (this.active + delta + this.tabs.length) % this.tabs.length;
    this.tab()!.unread = false;
  }

  private scrollBy(delta: number): void {
    const tab = this.tab();
    if (!tab) return;
    tab.scroll = Math.max(0, Math.min(tab.lines.length * 4, tab.scroll + delta));
  }

  private listTabs(): void {
    const lines: Line[] = [{ text: 'open tabs:', color: 'bold' }];
    this.tabs.forEach((tab, i) => {
      const marker = i === this.active ? '*' : ' ';
      lines.push({ text: ` ${marker}${i + 1}: ${tab.wsName}/${tab.title}`, color: 'normal' });
    });
    const tab = this.tab();
    if (tab) this.appendTo(tab, lines);
  }

  // ── Pickers ──────────────────────────────────────────────────────────

  private async startPicker(): Promise<void> {
    try {
      const items = await this.workspaces();
      this.mode = { kind: 'pickWorkspace', items };
    } catch (err) {
      this.note(`failed to list workspaces: ${String(err)}`, 'red');
    }
    this.render();
  }

  private handlePickerKey(key: Key): void {
    if (key.type === 'esc') {
      this.mode = { kind: 'normal' };
      if (this.tabs.length === 0) void this.startPicker();
      else this.render();
      return;
    }
    if (key.type !== 'char') return;
    const ch = key.ch;

    if (this.mode.kind === 'pickWorkspace') {
      const index = ch.charCodeAt(0) - '1'.charCodeAt(0);
      const ws = this.mode.items[index];
      if (!ws) return;
      void (async () => {
        try {
          const chats = await this.client.listChats(ws.id);
          this.mode = { kind: 'pickChat', ws, items: chats };
        } catch (err) {
          this.mode = { kind: 'normal' };
          this.note(`failed to list chats: ${String(err)}`, 'red');
        }
        this.render();
      })();
      return;
    }

    if (this.mode.kind === 'pickChat') {
      const { ws, items } = this.mode;
      if (ch === 'n' || ch === '0') {
        this.mode = { kind: 'normal' };
        void this.openTab(ws).catch(err => this.note(String(err), 'red'));
        return;
      }
      const index = ch.charCodeAt(0) - '1'.charCodeAt(0);
      const row = items[index];
      if (!row) return;
      this.mode = { kind: 'normal' };
      void this.openTab(ws, row.conversationId).catch(err => this.note(String(err), 'red'));
    }
  }

  private pickerLines(): Line[] {
    if (this.mode.kind === 'pickWorkspace') {
      const lines: Line[] = [{ text: 'open a chat — pick a workspace (Esc to cancel):', color: 'bold' }];
      this.mode.items.forEach((ws, i) => {
        lines.push({ text: ` ${i + 1}: ${ws.name}${ws.active ? ' (active)' : ''}`, color: 'normal' });
      });
      return lines;
    }
    if (this.mode.kind === 'pickChat') {
      const lines: Line[] = [{ text: `chats in ${this.mode.ws.name} — pick one, or n for new (Esc to cancel):`, color: 'bold' }];
      this.mode.items.slice(0, 9).forEach((c, i) => {
        lines.push({ text: ` ${i + 1}: ${c.title}${c.open ? ' (open)' : ''}`, color: 'normal' });
      });
      lines.push({ text: ' n: new chat', color: 'cyan' });
      return lines;
    }
    return [];
  }

  // ── Input submission ─────────────────────────────────────────────────

  private async submit(text: string): Promise<void> {
    if (text.startsWith('/')) {
      await this.command(text);
      return;
    }
    const tab = this.tab();
    if (!tab) { this.note(`no open tab — C-${this.prefixKey} c to open a chat`, 'yellow'); return; }
    try {
      await this.client.send(tab.workspaceId, tab.conversationId, text);
    } catch (err) {
      this.appendTo(tab, [{ text: `send failed: ${String(err)}`, color: 'red' }]);
      this.render();
    }
  }

  private async command(text: string): Promise<void> {
    const [cmd, ...rest] = text.slice(1).split(/\s+/);
    const arg = rest.join(' ').trim();
    const tab = this.tab();
    try {
      switch (cmd) {
        case 'help':
          if (tab) this.appendTo(tab, helpLines(this.prefixKey).map(l => ({ text: l, color: 'dim' as LineColor })));
          break;
        case 'new':
          if (!tab) { void this.startPicker(); break; }
          await this.openTab({ id: tab.workspaceId, name: tab.wsName }, undefined, arg || undefined);
          break;
        case 'open':
          await this.startPicker();
          break;
        case 'tabs':
          this.listTabs();
          break;
        case 'tab':
          if (arg === 'next') this.cycleTab(1);
          else if (arg === 'prev') this.cycleTab(-1);
          else {
            const n = parseInt(arg, 10);
            if (n >= 1 && n <= this.tabs.length) { this.active = n - 1; this.tab()!.unread = false; }
          }
          break;
        case 'close':
          this.closeTab(this.active);
          break;
        case 'rename':
          if (tab && arg) {
            await this.client.renameChat(tab.workspaceId, tab.conversationId, arg);
            tab.title = arg;
          }
          break;
        case 'delete':
          if (tab) {
            await this.client.deleteChat(tab.workspaceId, tab.conversationId);
            this.closeTab(this.active);
          }
          break;
        case 'history':
          if (tab) await this.loadHistory(tab);
          break;
        case 'stop':
        case 'pause':
        case 'resume':
          if (tab) {
            const op = cmd === 'stop' ? 'stopGoal' : cmd === 'pause' ? 'pauseGoal' : 'resumeGoal';
            await this.client.goalControl(op, tab.workspaceId, tab.conversationId);
            this.note(`${cmd} requested`, 'yellow');
          }
          break;
        case 'ws':
          if (rest[0] === 'new' && rest.slice(1).join(' ').trim()) {
            const name = rest.slice(1).join(' ').trim();
            await this.client.createWorkspace(name);
            this.note(`workspace created: ${name}`, 'green');
          } else if (arg) {
            const workspaces = await this.workspaces();
            const n = parseInt(arg, 10);
            const target = Number.isInteger(n)
              ? workspaces[n - 1]
              : workspaces.find(w => w.name.toLowerCase() === arg.toLowerCase());
            if (!target) {
              this.note(`no such workspace: ${arg} (try /ws to list)`, 'yellow');
            } else {
              await this.client.switchWorkspace(target.id);
              this.note(`active workspace: ${target.name}`, 'green');
            }
          } else {
            const workspaces = await this.workspaces();
            if (tab) {
              this.appendTo(tab, [
                { text: 'workspaces:', color: 'bold' },
                ...workspaces.map((w, i) => ({
                  text: `  ${i + 1}: ${w.name}${w.active ? ' (active)' : ''}`,
                  color: 'normal' as LineColor,
                })),
              ]);
            }
          }
          break;
        case 'quit':
        case 'exit':
          this.quit();
          break;
        default:
          this.note(`unknown command: /${cmd} (try /help)`, 'yellow');
      }
    } catch (err) {
      this.note(String(err instanceof Error ? err.message : err), 'red');
    }
    this.render();
  }

  // ── Render ───────────────────────────────────────────────────────────

  private render(): void {
    const tab = this.tab();
    const tabs: TabInfo[] = this.tabs.map((t, i) => ({
      label: `${t.wsName}/${t.title}`.slice(0, 24),
      active: i === this.active,
      unread: t.unread,
      busy: t.busy,
    }));
    if (tab && this.mode.kind === 'normal') tab.unread = false;
    const dialogActive = this.dialogQueue.length > 0;
    const tabLines = tab
      ? (tab.goal ? [...tab.lines, ...this.goalPanelLines(tab)] : tab.lines)
      : [];
    this.screen.render({
      tabs,
      lines: dialogActive ? this.dialogLines()
        : this.mode.kind === 'normal' ? tabLines : this.pickerLines(),
      scrollOffset: !dialogActive && this.mode.kind === 'normal' ? (tab?.scroll ?? 0) : 0,
      input: this.input,
      cursor: this.cursor,
      status: this.status || undefined,
      toast: this.currentToast,
    });
  }
}

// ── Plain REPL (dumb terminals, pipes, debugging) ──────────────────────

async function runPlain(url: string): Promise<void> {
  let workspace: WorkspaceRow | null = null;
  let conversationId: string | null = null;
  let pendingDialog: DialogInfo | null = null;

  const print = (line: Line) => {
    const codes: Record<LineColor, string> = {
      normal: '', bold: '\x1b[1m', dim: '\x1b[2m', cyan: '\x1b[36m',
      green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
    };
    if (!process.stdout.isTTY) {
      process.stdout.write(stripAnsi(line.text) + '\n');
      return;
    }
    process.stdout.write(codes[line.color] + line.text + '\x1b[0m\n');
  };

  const client = new CommuneClient({
    url,
    getCredentials: makeCredentialProvider(url),
    onToken: (token) => saveToken(url, token),
    onEvent: (event) => {
      if (event.event === 'message' && event.conversationId === conversationId) {
        const data = event.data as unknown as MessageEvent;
        for (const line of formatMessage(data.role, data.sender, data.text,
          isMarkdownMessage(data.role, data.markdown))) print(line);
      } else if (event.event === 'goalProgress' && event.workspaceId === workspace?.id) {
        // Milestones only — the step-by-step goalUpdated chatter would flood a
        // line-oriented log.
        if (String((event.data as { aspect?: unknown }).aspect) !== 'goalUpdated') {
          const { line } = formatGoal(event.data);
          if (line) print(line);
        }
      } else if (event.event === 'toast') {
        const { message, level } = event.data as { message: string; level: string };
        print({ text: `[toast] ${message}`, color: level === 'error' ? 'red' : 'yellow' });
      } else if (event.event === 'dialog') {
        pendingDialog = event.data as unknown as DialogInfo;
        print({ text: `[dialog] ${pendingDialog.title}: ${pendingDialog.message}`, color: 'yellow' });
        if (pendingDialog.resource) print({ text: `  ${pendingDialog.resource}`, color: 'yellow' });
        if (pendingDialog.kind === 'options' && pendingDialog.options) {
          pendingDialog.options.forEach((option, i) =>
            print({ text: `  ${i + 1}: ${option.label}`, color: 'normal' }));
          print({ text: 'respond with /answer <number> or /no', color: 'dim' });
        } else {
          print({
            text: pendingDialog.kind === 'prompt'
              ? 'respond with /answer <text> or /no'
              : 'respond with /yes or /no',
            color: 'dim',
          });
        }
      } else if (event.event === 'dialogClosed') {
        const { dialogId } = event.data as { dialogId: string };
        if (pendingDialog?.dialogId === dialogId) {
          pendingDialog = null;
          print({ text: '[dialog] answered elsewhere', color: 'dim' });
        }
      }
    },
    onClose: (reason) => {
      print({ text: `disconnected: ${reason}`, color: 'red' });
      process.exit(1);
    },
  });

  await client.connect();
  const workspaces = await client.listWorkspaces();
  if (workspaces.length === 0) throw new Error('No workspaces available');
  workspace = workspaces.find(w => w.active) ?? workspaces[0];

  const openLatestOrNew = async (): Promise<void> => {
    const chats = await client.listChats(workspace!.id);
    const opened = chats.length > 0
      ? await client.openChat(workspace!.id, chats[0].conversationId)
      : await client.newChat(workspace!.id);
    conversationId = opened.conversationId;
    const history = await client.history(workspace!.id, conversationId);
    for (const entry of history) {
      for (const line of formatMessage(entry.role, entry.sender ?? entry.role, entry.content,
        isMarkdownMessage(entry.role))) print(line);
    }
    print({ text: `— ${workspace!.name} / ${chats.find(c => c.conversationId === conversationId)?.title ?? 'new chat'} —`, color: 'dim' });
  };
  await openLatestOrNew();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
  rl.prompt();

  rl.on('line', (raw: string) => {
    const text = raw.trim();
    void (async () => {
      try {
        if (text === '/quit' || text === '/exit') { rl.close(); return; }
        if (text === '/chats') {
          const chats = await client.listChats(workspace!.id);
          chats.forEach((c, i) => print({ text: ` ${i + 1}: ${c.title}`, color: 'normal' }));
        } else if (text.startsWith('/open ')) {
          const n = parseInt(text.slice(6).trim(), 10);
          const chats = await client.listChats(workspace!.id);
          const row = chats[n - 1];
          if (!row) { print({ text: 'no such chat', color: 'yellow' }); }
          else {
            const opened = await client.openChat(workspace!.id, row.conversationId);
            conversationId = opened.conversationId;
            print({ text: `opened: ${row.title}`, color: 'dim' });
          }
        } else if (text.startsWith('/new')) {
          const title = text.slice(4).trim() || undefined;
          const opened = await client.newChat(workspace!.id, title);
          conversationId = opened.conversationId;
          print({ text: 'new chat opened', color: 'dim' });
        } else if (text === '/ws') {
          (await client.listWorkspaces()).forEach((w, i) =>
            print({ text: ` ${i + 1}: ${w.name}${w.active ? ' (active)' : ''}`, color: 'normal' }));
        } else if (text.startsWith('/ws ')) {
          const arg = text.slice(4).trim();
          const all = await client.listWorkspaces();
          const n = parseInt(arg, 10);
          const target = Number.isInteger(n)
            ? all[n - 1]
            : all.find(w => w.name.toLowerCase() === arg.toLowerCase());
          if (!target) print({ text: `no such workspace: ${arg}`, color: 'yellow' });
          else {
            await client.switchWorkspace(target.id);
            print({ text: `active workspace: ${target.name}`, color: 'green' });
          }
        } else if (text.startsWith('/use ')) {
          const n = parseInt(text.slice(5).trim(), 10);
          const all = await client.listWorkspaces();
          if (all[n - 1]) {
            workspace = all[n - 1];
            print({ text: `workspace: ${workspace.name}`, color: 'dim' });
            await openLatestOrNew();
          }
        } else if (text === '/stop') {
          await client.goalControl('stopGoal', workspace!.id, conversationId!);
        } else if (text === '/yes' || text === '/no' || text.startsWith('/answer ')) {
          if (!pendingDialog) {
            print({ text: 'no dialog waiting', color: 'yellow' });
          } else if (text === '/no') {
            await client.respondDialog(pendingDialog.dialogId, false);
            pendingDialog = null;
          } else if (pendingDialog.kind === 'options') {
            const n = parseInt(text.startsWith('/answer ') ? text.slice(8).trim() : '', 10);
            const option = pendingDialog.options?.[n - 1];
            if (!option) {
              print({ text: 'pick an option number with /answer <number>', color: 'yellow' });
            } else {
              await client.respondDialog(pendingDialog.dialogId, true, undefined, option.id);
              pendingDialog = null;
            }
          } else {
            const value = text.startsWith('/answer ') ? text.slice(8) : undefined;
            await client.respondDialog(pendingDialog.dialogId, true, value);
            pendingDialog = null;
          }
        } else if (text === '/help') {
          print({ text: 'plain mode: /chats /open N /new [title] /ws [n|name] /use N /stop /yes /no /answer <text> /quit — anything else is sent to the chat. /ws N sets the active workspace; /use N only retargets this REPL', color: 'dim' });
        } else if (text) {
          await client.send(workspace!.id, conversationId!, text);
        }
      } catch (err) {
        print({ text: String(err instanceof Error ? err.message : err), color: 'red' });
      }
      rl.prompt();
    })();
  });

  rl.on('close', () => {
    client.close();
    process.exit(0);
  });
}

// ── Entry ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('usage: commune [--plain] [--url ws://host:port]');
    console.log('  (from a source checkout: pnpm commune)');
    console.log('Requires a running Abject desktop app or backend on this machine.');
    console.log('env: CLI_PORT, COMMUNE_URL, ABJECTS_AUTH_USER, ABJECTS_AUTH_PASSWORD');
    return;
  }
  const urlFlag = args.indexOf('--url');
  const url = urlFlag >= 0 && args[urlFlag + 1]
    ? args[urlFlag + 1]
    : process.env.COMMUNE_URL ?? `ws://127.0.0.1:${process.env.CLI_PORT ?? '7723'}`;

  const plain = args.includes('--plain') || !process.stdout.isTTY || !process.stdin.isTTY;

  if (plain) {
    await runPlain(url);
  } else {
    const app = new TuiApp(url);
    await app.run();
  }
}

main().catch((err) => {
  process.stdout.write('\x1b[?25h\x1b[?1049l');
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
