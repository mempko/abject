/**
 * CommuneClient -- WebSocket client for the CliServer gateway.
 *
 * Handles the shared auth handshake (authRequired / authNotRequired, token
 * resume, username+password login) and the JSON op protocol:
 *   -> { id, op, ...params }
 *   <- { id, ok, result | error }
 *   <- { event, workspaceId, conversationId?, data }   (pushed)
 */

import WebSocket from 'ws';

export interface WorkspaceRow {
  id: string;
  name: string;
  accessMode: string;
  active: boolean;
}

export interface ConversationRow {
  conversationId: string;
  title: string;
  createdAt: number;
  lastActiveAt: number;
  /** True when this chat's window is currently on the desktop. */
  open: boolean;
}

export interface HistoryEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
  sender?: string;
}

export interface MessageEvent {
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'error';
  sender: string;
  text: string;
  markdown: boolean;
  at: number;
}

export interface PushedEvent {
  event: string;
  workspaceId: string;
  conversationId?: string;
  data: Record<string, unknown>;
}

export interface DialogOption {
  id: string;
  label: string;
}

export interface DialogInfo {
  dialogId: string;
  kind: 'confirm' | 'prompt' | 'options';
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  placeholder?: string;
  defaultValue?: string;
  /** The resource being decided on (e.g. a command line), for options dialogs. */
  resource?: string;
  /** Choice list for options dialogs. */
  options?: DialogOption[];
}

export interface GoalTask {
  id: string;
  description: string;
  status: string;
  agentName?: string;
  /** Task ids this one waits on, so the panel can order and annotate them. */
  dependsOn?: string[];
}

export interface GoalStatus {
  goalId: string;
  title: string;
  description?: string;
  status: string;
  error?: string;
  tasks: GoalTask[];
}

export type Credentials = { token: string } | { username: string; password: string };

export interface CommuneClientOptions {
  url: string;
  /**
   * Called when the server requires auth. `attempt` starts at 0 (use the
   * cached token if there is one) and increments on each rejection (prompt
   * the user). Return null to give up.
   */
  getCredentials: (attempt: number, error?: string) => Promise<Credentials | null>;
  /** Called when a login mints a fresh session token (cache it). */
  onToken?: (token: string) => void;
  onEvent: (event: PushedEvent) => void;
  onClose: (reason: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CommuneClient {
  private ws: WebSocket | null = null;
  private readonly opts: CommuneClientOptions;
  private pending: Map<number, Pending> = new Map();
  private nextId = 1;
  private ready = false;
  private closed = false;
  private authAttempt = 0;

  constructor(opts: CommuneClientOptions) {
    this.opts = opts;
  }

  /** Connect and complete the auth handshake. Resolves when ops can be sent. */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      this.ws = ws;
      this.ready = false;
      this.closed = false;
      this.authAttempt = 0;
      let settled = false;

      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err); else resolve();
      };

      ws.on('message', (data) => {
        let msg: Record<string, unknown>;
        try { msg = JSON.parse(String(data)); } catch { return; }

        if (!this.ready) {
          this.handleHandshake(msg, settle);
          return;
        }
        if (typeof msg.event === 'string') {
          this.opts.onEvent(msg as unknown as PushedEvent);
          return;
        }
        this.handleReply(msg);
      });

      ws.on('error', (err) => {
        settle(err instanceof Error ? err : new Error(String(err)));
      });

      ws.on('close', (code, reasonBuf) => {
        const reason = reasonBuf?.toString() || `connection closed (${code})`;
        settle(new Error(reason));
        this.failAllPending(reason);
        if (!this.closed) {
          this.closed = true;
          this.opts.onClose(reason);
        }
      });
    });
  }

  private handleHandshake(msg: Record<string, unknown>, settle: (err?: Error) => void): void {
    if (msg.type === 'authNotRequired') {
      this.ready = true;
      settle();
      return;
    }
    if (msg.type === 'authRequired') {
      void this.submitCredentials(undefined, settle);
      return;
    }
    if (msg.type === 'authResult') {
      if (msg.success) {
        if (typeof msg.token === 'string') this.opts.onToken?.(msg.token);
        this.ready = true;
        settle();
      } else {
        this.authAttempt++;
        void this.submitCredentials(typeof msg.error === 'string' ? msg.error : 'Authentication failed', settle);
      }
    }
  }

  private async submitCredentials(error: string | undefined, settle: (err?: Error) => void): Promise<void> {
    const creds = await this.opts.getCredentials(this.authAttempt, error);
    if (!creds) {
      settle(new Error(error ?? 'Authentication cancelled'));
      this.close();
      return;
    }
    this.sendRaw({ type: 'auth', ...creds });
  }

  private handleReply(msg: Record<string, unknown>): void {
    const id = typeof msg.id === 'number' ? msg.id : -1;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (msg.ok) {
      pending.resolve(msg.result);
    } else {
      pending.reject(new Error(typeof msg.error === 'string' ? msg.error : 'Request failed'));
    }
  }

  private failAllPending(reason: string): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private sendRaw(payload: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Not connected');
    }
    this.ws.send(JSON.stringify(payload));
  }

  request<T = unknown>(op: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    if (!this.ready) return Promise.reject(new Error('Not connected'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out: ${op}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.sendRaw({ id, op, ...params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ── Typed convenience wrappers ───────────────────────────────────────

  listWorkspaces(): Promise<WorkspaceRow[]> {
    return this.request('listWorkspaces');
  }

  createWorkspace(name: string): Promise<{ workspaceId: string }> {
    return this.request('createWorkspace', { name });
  }

  switchWorkspace(workspaceId: string): Promise<boolean> {
    return this.request('switchWorkspace', { workspaceId });
  }

  listChats(workspaceId: string): Promise<ConversationRow[]> {
    return this.request('listChats', { workspaceId });
  }

  newChat(workspaceId: string, title?: string): Promise<{ conversationId: string; chatId: string }> {
    return this.request('newChat', title ? { workspaceId, title } : { workspaceId });
  }

  openChat(workspaceId: string, conversationId: string): Promise<{ conversationId: string; chatId: string }> {
    return this.request('openChat', { workspaceId, conversationId });
  }

  closeChat(workspaceId: string, conversationId: string): Promise<boolean> {
    return this.request('closeChat', { workspaceId, conversationId });
  }

  renameChat(workspaceId: string, conversationId: string, title: string): Promise<boolean> {
    return this.request('renameChat', { workspaceId, conversationId, title });
  }

  deleteChat(workspaceId: string, conversationId: string): Promise<boolean> {
    return this.request('deleteChat', { workspaceId, conversationId });
  }

  send(workspaceId: string, conversationId: string, message: string): Promise<boolean> {
    return this.request('send', { workspaceId, conversationId, message });
  }

  history(workspaceId: string, conversationId: string): Promise<HistoryEntry[]> {
    return this.request('history', { workspaceId, conversationId });
  }

  goalControl(op: 'stopGoal' | 'pauseGoal' | 'resumeGoal', workspaceId: string, conversationId: string): Promise<boolean> {
    return this.request(op, { workspaceId, conversationId });
  }

  goalStatus(workspaceId: string, goalId: string): Promise<GoalStatus | null> {
    return this.request('goalStatus', { workspaceId, goalId });
  }

  respondDialog(dialogId: string, confirmed: boolean, value?: string, option?: string): Promise<boolean> {
    const params: Record<string, unknown> = { dialogId, confirmed };
    if (value !== undefined) params.value = value;
    if (option !== undefined) params.option = option;
    return this.request('respondDialog', params);
  }

  get isReady(): boolean {
    return this.ready && this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    this.failAllPending('Client closed');
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
    this.ready = false;
  }
}
