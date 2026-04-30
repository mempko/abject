/**
 * Chat — conversational LLM agent.
 *
 * Provides a chat window where users type natural language requests.
 * Registers with AgentAbject as an agent — AgentAbject drives the
 * think-act-observe state machine, calling back Chat for observe and act.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import type { AgentAction } from './agent-abject.js';
import { estimateWrappedLineCount } from './widgets/word-wrap.js';
import { estimateMarkdownHeight } from './widgets/markdown.js';
import { lightenColor, darkenColor } from './widgets/widget-types.js';
import { Log } from '../core/timed-log.js';

const log = new Log('Chat');
const CHAT_INTERFACE: InterfaceId = 'abjects:chat';

const DEFAULT_WIN_W = 640;
const DEFAULT_WIN_H = 620;

// ── Bubble styling ─────────────────────────────────────────────────────
const BUBBLE_MAX_FRACTION = 0.75;
const BUBBLE_MIN_WIDTH = 240;
const SENDER_LABEL_HEIGHT = 18;
const GROUP_WINDOW_MS = 3 * 60_000;

// ── Composer ───────────────────────────────────────────────────────────
const SEND_GLYPH = '\u27A4';       // ➤
const SEND_BTN_SIZE = 44;
const INPUT_MIN_HEIGHT = 44;

// ── Conversation ───────────────────────────────────────────────────────
const MAX_CONVERSATION_ENTRIES = 40;
const MAX_STEPS = 20;

// Role → bubble styling map. Values are resolved lazily against `this.theme`
// in `bubbleStyleForRole`.
type BubbleRole = 'user' | 'assistant' | 'system' | 'error' | 'activity';
type BubbleAlign = 'left' | 'center' | 'right';

interface MessageMeta {
  role: BubbleRole;
  sender: string;
  ts: number;
  text: string;
  markdown: boolean;
  align: BubbleAlign;
}

interface SuggestionChip {
  label: string;
  prompt: string;
}

const DEFAULT_SUGGESTIONS: SuggestionChip[] = [
  { label: 'What objects do I have?', prompt: 'What objects do I have?' },
  { label: 'Create a weather reporter', prompt: 'Create a weather reporter that posts daily briefings to chat.' },
  { label: 'Show me the system', prompt: 'Give me a tour of what this system can do.' },
];

// ─── Chat-specific types ─────────────────────────────────────────────

interface ConversationEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ObjectSummary {
  id: AbjectId;
  name: string;
  description: string;
}

type UiPhase = 'closed' | 'idle' | 'busy';

interface ChatConstructorArgs {
  conversationId?: string;
  title?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export class Chat extends Abject {
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;
  private agentAbjectId?: AbjectId;
  private storageId?: AbjectId;
  private chatManagerId?: AbjectId;

  // Conversation identity (passed via constructor args; unset for legacy callers)
  private conversationId?: string;
  private conversationTitle?: string;
  private initialRect?: { x: number; y: number; width: number; height: number };
  private currentRect?: { x: number; y: number; width: number; height: number };
  private rectPersistTimer?: ReturnType<typeof setTimeout>;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private historyLoaded = false;

  // Window/widget IDs
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private messageLogId?: AbjectId;
  private inputRowId?: AbjectId;
  private textInputId?: AbjectId;
  private sendBtnId?: AbjectId;

  private messageLabelIds: AbjectId[] = [];
  private conversationHistory: ConversationEntry[] = [];
  private uiPhase: UiPhase = 'closed';

  /** Current content width of the window (updated on resize). */
  private currentWindowWidth = DEFAULT_WIN_W;

  /** Per-message metadata (role/sender/timestamp) keyed by label AbjectId. */
  private messageMetadata = new Map<AbjectId, MessageMeta>();

  /** bubble label id → its preceding sender header label id (if any). */
  private bubbleSenderLabels = new Map<AbjectId, AbjectId>();

  /** Pending debounced resize-reflow timer. */
  private reflowTimer?: ReturnType<typeof setTimeout>;

  /** Consolidated "Thinking / activity" bubble used during task execution. */
  private activityBubbleLabelId?: AbjectId;
  private activityStep = 0;
  private activityHeader = '\u25CF Thinking\u2026';
  private activityRefreshTimer?: ReturnType<typeof setTimeout>;
  private activityRefreshLastHeight = 0;
  /** Streamed character count for the current LLM step. Reset each phase. */
  private stepStreamChars = 0;

  /**
   * Live snapshot of goals being worked on for the current task. Mirrors what
   * GoalBrowser shows but rendered as indented text inside the activity
   * bubble. Updated from goalCreated/goalUpdated/goalCompleted/goalFailed
   * events emitted by GoalManager.
   */
  private liveGoals = new Map<string, {
    title: string;
    status: 'active' | 'completed' | 'failed';
    parentId?: string;
    latestMessage?: string;
    latestAgent?: string;
  }>();

  /** Task info per goal, fetched from GoalManager. */
  private liveTasks = new Map<string, Array<{
    id: string;
    description: string;
    status: string;
    agentName?: string;
    claimedBy?: string;
    attempts: number;
    maxAttempts: number;
  }>>();

  /** Welcome-card widget ids (destroyed on first send / clear). */
  private welcomeWidgetIds: AbjectId[] = [];

  /** Composer hint label (rendered under the input row). */
  private composerHintLabelId?: AbjectId;
  private composerRowId?: AbjectId;
  private composerColumnId?: AbjectId;

  /** Pending ticket promises: ticketId → resolve/reject. */
  private pendingTickets = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; timeoutMs: number }>();

  /** Current active ticket ID (for progress/stream routing). */
  private _currentTicketId?: string;

  /** Accumulated streaming buffer for current task. */
  private _streamBuffer = '';

  /** GoalManager ID for cross-agent progress tracking. */
  private goalManagerId?: AbjectId;

  /** Current goal ID for the active task. */
  private _currentGoalId?: string;

  /** Pending task completion promises: taskId → resolve/reject. */
  private pendingTaskCompletions = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; timeoutMs: number }>();

  constructor(args?: ChatConstructorArgs) {
    super({
      manifest: {
        name: 'Chat',
        description:
          'Conversational LLM agent. Chat naturally to explore, create, and control Abjects. Uses a think-act-observe loop with structured actions.',
        version: '1.0.0',
        interface: {
            id: CHAT_INTERFACE,
            name: 'Chat',
            description: 'Conversational LLM agent UI',
            methods: [
              {
                name: 'show',
                description: 'Show the chat window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Hide the chat window',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'sendMessage',
                description: 'Send a message programmatically to the chat agent',
                parameters: [
                  { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'The message text' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getState',
                description: 'Return current state of the chat',
                parameters: [],
                returns: { kind: 'object', properties: {
                  phase: { kind: 'primitive', primitive: 'string' },
                  messageCount: { kind: 'primitive', primitive: 'number' },
                  visible: { kind: 'primitive', primitive: 'boolean' },
                  currentGoalId: { kind: 'primitive', primitive: 'string' },
                }},
              },
              {
                name: 'addNotification',
                description: 'Display a message in the chat window without triggering the agent loop. Use this for notifications, status updates, or results from other agents.',
                parameters: [
                  { name: 'sender', type: { kind: 'primitive', primitive: 'string' }, description: 'Display name of the sender (e.g. agent name)' },
                  { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'The notification text (supports markdown)' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'attachMedia',
                description: 'Append an assistant bubble containing markdown media (typically an image data URI from a screenshot or render). Bypasses conversationHistory so large data URIs never enter the LLM context — the LLM sees the agent\'s text summary instead. Use this from sub-task agents that captured user-facing media.',
                parameters: [
                  { name: 'markdown', type: { kind: 'primitive', primitive: 'string' }, description: 'Markdown content to render (e.g. ![alt|WxH](data:image/png;base64,...))' },
                  { name: 'sender', type: { kind: 'primitive', primitive: 'string' }, description: 'Optional display name; defaults to "Agent"' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'clearHistory',
                description: 'Reset conversation history',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'setTitle',
                description: 'Update the conversation title (reflected in the window title bar).',
                parameters: [
                  { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'New conversation title' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
            events: [
              {
                name: 'messageAdded',
                description: 'Fires every time a bubble is appended to the chat log (user input, assistant reply, system notification, or error). Subscribe via addDependent to forward, mirror, or log messages from bridges, proxies, relays, and integrations. The "activity" role represents in-progress agent state and is filtered out; subscribers see only durable bubbles. Includes conversationId for multi-chat subscribers.',
                payload: { kind: 'object', properties: {
                  conversationId: { kind: 'primitive', primitive: 'string' },
                  role: { kind: 'primitive', primitive: 'string' },
                  sender: { kind: 'primitive', primitive: 'string' },
                  text: { kind: 'primitive', primitive: 'string' },
                  markdown: { kind: 'primitive', primitive: 'boolean' },
                  at: { kind: 'primitive', primitive: 'number' },
                }},
              },
              {
                name: 'titleChanged',
                description: 'Fires when the conversation title changes (either via setTitle or auto-derived from the first user message).',
                payload: { kind: 'object', properties: {
                  conversationId: { kind: 'primitive', primitive: 'string' },
                  title: { kind: 'primitive', primitive: 'string' },
                }},
              },
              {
                name: 'rectChanged',
                description: 'Fires when the chat window is moved or resized; ChatManager uses this to persist per-conversation window geometry.',
                payload: { kind: 'object', properties: {
                  conversationId: { kind: 'primitive', primitive: 'string' },
                  rect: { kind: 'object', properties: {
                    x: { kind: 'primitive', primitive: 'number' },
                    y: { kind: 'primitive', primitive: 'number' },
                    width: { kind: 'primitive', primitive: 'number' },
                    height: { kind: 'primitive', primitive: 'number' },
                  } },
                }},
              },
            ],
          },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display chat window', required: true },
          { capability: Capabilities.LLM_QUERY, reason: 'Query LLM for responses', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui', 'agent'],
      },
    });

    if (args) {
      this.conversationId = args.conversationId;
      this.conversationTitle = args.title;
      this.initialRect = args.rect;
    }

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.registryId = await this.requireDep('Registry');
    this.agentAbjectId = await this.requireDep('AgentAbject');
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    this.chatManagerId = await this.discoverDep('ChatManager') ?? undefined;

    // Subscribe to GoalManager for real-time goal updates
    if (this.goalManagerId) {
      this.send(request(this.id, this.goalManagerId, 'addDependent', {}));
    }

    // Load persisted conversation history (if any) for this conversation.
    if (this.conversationId && !this.historyLoaded) {
      if (!this.storageId) {
        log.warn(`[Chat ${this.conversationId.slice(0, 8)}] Storage not found — history will not be loaded`);
      } else {
        try {
          const hist = await this.request<ConversationEntry[] | null>(
            request(this.id, this.storageId, 'get', { key: `chats:history:${this.conversationId}` })
          );
          if (Array.isArray(hist)) {
            this.conversationHistory = hist;
            log.info(`[Chat ${this.conversationId.slice(0, 8)}] Loaded ${hist.length} entries from history`);
          } else {
            log.info(`[Chat ${this.conversationId.slice(0, 8)}] No persisted history (key miss)`);
          }
        } catch (err) {
          log.warn(`[Chat ${this.conversationId.slice(0, 8)}] Failed to load history: ${String(err)}`);
        }
      }
      this.historyLoaded = true;
    } else if (!this.conversationId) {
      log.info(`[Chat ${this.id.slice(0, 8)}] No conversationId set — running in legacy single-chat mode`);
    }

    // Register with AgentAbject (fire-and-forget: handler is idempotent)
    this.send(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'Chat',
      description: 'Conversational LLM agent for interacting with Abjects',
      canExecute: false,
      config: {
        pinnedMessageCount: 1,
        terminalActions: {
          done: { type: 'success', resultFields: ['text', 'result', 'reasoning'] },
          clarify: { type: 'success', resultFields: ['question'] },
          fail: { type: 'error', resultFields: ['reason'] },
        },
        intermediateActions: ['reply'],
        skipFirstObservation: true,
      },
    }));
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
  }

  private setupHandlers(): void {
    this.on('show', async () => {
      return this.show();
    });

    this.on('hide', async () => {
      return this.hide();
    });

    this.on('sendMessage', async (msg: AbjectMessage) => {
      const { message } = msg.payload as { message: string };
      if (!message?.trim()) return false;
      log.info(`[Chat] sendMessage: "${message.trim().slice(0, 80)}"`);
      this.triggerSend(message.trim());
      return true;
    });

    this.on('attachMedia', async (msg: AbjectMessage) => {
      const { markdown, sender } = msg.payload as { markdown: string; sender?: string };
      if (!markdown?.trim()) return false;
      // Deliberately do NOT push to conversationHistory: the markdown carries
      // a data URI that would balloon every subsequent LLM call. The LLM
      // gets the originating agent's text summary instead.
      await this.removeWelcomeState();
      await this.appendBubble('assistant', sender || 'Agent', markdown.trim(), true);
      this.schedulePersist();
      return true;
    });

    this.on('addNotification', async (msg: AbjectMessage) => {
      const { sender, message } = msg.payload as { sender: string; message: string };
      if (!message?.trim()) return false;
      log.info(`[Chat] addNotification from "${sender}": "${message.trim().slice(0, 80)}"`);
      await this.removeWelcomeState();
      await this.appendBubble('system', sender || 'System', message.trim(), true);
      this.conversationHistory.push({ role: 'assistant', content: `[${sender}]: ${message.trim()}` });
      this.schedulePersist();
      return true;
    });

    this.on('getState', async () => {
      return {
        phase: this.uiPhase,
        messageCount: this.conversationHistory.length,
        visible: !!this.windowId,
        currentGoalId: this._currentGoalId ?? null,
      };
    });

    this.on('clearHistory', async () => {
      this.conversationHistory = [];
      // Drop persisted history too; the roster entry survives so the
      // conversation itself isn't deleted (ChatManager owns that).
      if (this.conversationId && this.storageId) {
        try {
          await this.request(request(this.id, this.storageId, 'delete', {
            key: `chats:history:${this.conversationId}`,
          }));
        } catch { /* best effort */ }
      }
      if (this.windowId) {
        await this.clearMessageLabels();
        await this.showWelcomeState();
      }
      return true;
    });

    this.on('setTitle', async (msg: AbjectMessage) => {
      const { title } = msg.payload as { title: string };
      const next = (title ?? '').trim().slice(0, 80);
      if (!next || next === this.conversationTitle) return false;
      this.conversationTitle = next;
      // Reflect in the open window's title bar, if any
      if (this.windowId) {
        try {
          await this.request(request(this.id, this.windowId, 'setTitle', {
            title: this.formatWindowTitle(next),
          }));
        } catch { /* best effort */ }
      }
      // Notify ChatManager for roster updates
      if (this.chatManagerId && this.conversationId) {
        this.send(event(this.id, this.chatManagerId, 'titleChanged', {
          conversationId: this.conversationId,
          title: next,
        }));
      }
      this.changed('titleChanged', { conversationId: this.conversationId ?? '', title: next });
      return true;
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });

    this.on('windowResized', async (msg: AbjectMessage) => {
      const { width, height } = msg.payload as { width: number; height: number };
      if (typeof width === 'number' && width > 0 && width !== this.currentWindowWidth) {
        this.currentWindowWidth = width;
        this.scheduleReflow();
      }
      if (this.currentRect) {
        if (typeof width === 'number' && width > 0) this.currentRect.width = width;
        if (typeof height === 'number' && height > 0) this.currentRect.height = height;
        this.notifyRectChanged();
      }
    });

    this.on('windowMoved', async (msg: AbjectMessage) => {
      const { x, y } = msg.payload as { x: number; y: number };
      if (this.currentRect) {
        if (typeof x === 'number') this.currentRect.x = x;
        if (typeof y === 'number') this.currentRect.y = y;
        this.notifyRectChanged();
      }
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      if (fromId === this.sendBtnId && aspect === 'click') {
        await this.handleSendClick();
        return;
      }

      if (fromId === this.textInputId && aspect === 'submit') {
        await this.handleSendClick();
        return;
      }

      // Welcome suggestion chips: clicking a chip sends the chip's prompt.
      if (aspect === 'click' && this.welcomeWidgetIds.includes(fromId)) {
        const chipText = value as string | undefined;
        const prompt = chipText ? this.promptForChipText(chipText) : undefined;
        if (prompt && this.uiPhase === 'idle') {
          await this.removeWelcomeState();
          this.triggerSend(prompt);
        }
        return;
      }

      if (fromId === this.textInputId && aspect === 'resize') {
        const { preferredHeight } = (msg.payload as { aspect: string; value: { preferredHeight: number } }).value;
        // Update text input height in HBox
        try {
          await this.request(request(this.id, this.inputRowId!, 'updateLayoutChild', {
            widgetId: this.textInputId,
            preferredSize: { height: preferredHeight },
          }));
          // Update input row height in root VBox
          await this.request(request(this.id, this.rootLayoutId!, 'updateLayoutChild', {
            widgetId: this.inputRowId,
            preferredSize: { height: preferredHeight },
          }));
        } catch { /* layout may be gone */ }
        return;
      }

      // GoalManager events
      if (fromId === this.goalManagerId) {
        const { value } = msg.payload as { aspect: string; value: unknown };

        // Task completion/failure — resolve pending waitForTaskCompletion promises
        if (aspect === 'taskCompleted') {
          const data = value as { taskId: string; goalId?: string; result?: unknown };
          const hasPending = this.pendingTaskCompletions.has(data.taskId);
          log.info(`[Chat] GoalManager taskCompleted ${data.taskId.slice(0, 8)} hasPending=${hasPending}`);
          const pending = this.pendingTaskCompletions.get(data.taskId);
          if (pending) {
            this.pendingTaskCompletions.delete(data.taskId);
            pending.resolve({ taskId: data.taskId, result: data.result });
          }
          // Refresh task cache for the goal
          if (data.goalId) this.fetchGoalTasks(data.goalId).then(() => this.scheduleActivityRefresh());
          return;
        }
        if (aspect === 'taskPermanentlyFailed') {
          const data = value as { taskId: string; goalId?: string; error?: string; attempts?: number };
          const hasPending = this.pendingTaskCompletions.has(data.taskId);
          log.info(`[Chat] GoalManager taskPermanentlyFailed ${data.taskId.slice(0, 8)} attempts=${data.attempts ?? '?'} hasPending=${hasPending} error="${(data.error ?? '').slice(0, 60)}"`);
          const pending = this.pendingTaskCompletions.get(data.taskId);
          if (pending) {
            this.pendingTaskCompletions.delete(data.taskId);
            pending.reject(new Error(data.error ?? 'Task permanently failed'));
          }
          if (data.goalId) this.fetchGoalTasks(data.goalId).then(() => this.scheduleActivityRefresh());
          return;
        }
        // taskRetrying — task will be re-dispatched, don't reject the promise
        if (aspect === 'taskRetrying') {
          const data = value as { taskId: string; goalId?: string; attempts?: number; maxAttempts?: number; error?: string };
          log.info(`[Chat] GoalManager taskRetrying ${data.taskId.slice(0, 8)} attempts=${data.attempts ?? '?'}/${data.maxAttempts ?? '?'} — NOT rejecting promise`);
          if (data.goalId) this.fetchGoalTasks(data.goalId).then(() => this.scheduleActivityRefresh());
          return;
        }

        // Goal lifecycle events — feed the liveGoals tree so the activity
        // bubble can render the same hierarchy the GoalBrowser shows.
        if (this._currentGoalId) {
          if (aspect === 'goalCreated') {
            const data = value as { goalId: string; title: string; parentId?: string };
            // Only track goals that are part of the current task's tree
            // (the current goal itself, or descendants of any goal we know).
            if (data.goalId === this._currentGoalId
                || (data.parentId && this.liveGoals.has(data.parentId))) {
              this.liveGoals.set(data.goalId, {
                title: data.title,
                status: 'active',
                parentId: data.parentId,
              });
              // Fetch tasks for this goal so we can render them
              this.fetchGoalTasks(data.goalId).then(() => this.scheduleActivityRefresh());
              this.scheduleActivityRefresh();
            }
            return;
          }

          if (aspect === 'goalUpdated') {
            const data = value as { goalId: string; parentId?: string; message?: string; phase?: string; agentName?: string };
            // Reset pending timeouts on any goal progress
            this.resetTaskCompletionTimeouts();
            this.resetPendingTicketTimeouts();

            // Lazily seed the goal entry if we missed its creation event
            // (e.g. it was created before our subscription took effect).
            if (!this.liveGoals.has(data.goalId)
                && (data.goalId === this._currentGoalId
                    || (data.parentId && this.liveGoals.has(data.parentId)))) {
              this.liveGoals.set(data.goalId, {
                title: '(in progress)',
                status: 'active',
                parentId: data.parentId,
              });
              // Fetch the real title from GoalManager
              this.fetchGoalTitle(data.goalId);
              this.fetchGoalTasks(data.goalId).then(() => this.scheduleActivityRefresh());
            }

            const entry = this.liveGoals.get(data.goalId);
            if (entry) {
              if (data.message) entry.latestMessage = data.message;
              if (data.agentName && data.agentName !== 'Chat') entry.latestAgent = data.agentName;
              // Refetch tasks on any progress so we always show current state
              this.fetchGoalTasks(data.goalId).then(() => this.scheduleActivityRefresh());
              this.scheduleActivityRefresh();
            }
            return;
          }

          if (aspect === 'goalCompleted') {
            const data = value as { goalId: string };
            const entry = this.liveGoals.get(data.goalId);
            if (entry) {
              entry.status = 'completed';
              this.scheduleActivityRefresh();
            }
            return;
          }

          if (aspect === 'goalFailed') {
            const data = value as { goalId: string; error?: string };
            const entry = this.liveGoals.get(data.goalId);
            if (entry) {
              entry.status = 'failed';
              if (data.error) entry.latestMessage = data.error;
              this.scheduleActivityRefresh();
            }
            return;
          }
        }
      }
    });

    // ── Ticket result/progress/stream handlers ──

    this.on('taskResult', async (msg: AbjectMessage) => {
      const payload = msg.payload as { ticketId: string };
      const pending = this.pendingTickets.get(payload.ticketId);
      if (pending) {
        this.pendingTickets.delete(payload.ticketId);
        pending.resolve(payload);
      }
    });

    this.on('taskProgress', async (msg: AbjectMessage) => {
      // Reset pending ticket timeouts on agent progress
      this.resetPendingTicketTimeouts();

      const { ticketId, step, maxSteps, phase } =
        msg.payload as { ticketId: string; step: number; maxSteps: number; phase: string; action?: string };
      if (!this._currentTicketId) return;
      if (ticketId && ticketId !== this._currentTicketId) return;

      if (!this.activityBubbleLabelId) return;
      // Reset per-step stream counter on every phase boundary — each new
      // phase (thinking, observing, acting) is a fresh LLM call window.
      this.stepStreamChars = 0;
      if (phase === 'thinking') {
        this.updateActivityHeader(`\u25CF Thinking\u2026 (step ${step + 1}/${maxSteps})`);
      } else if (phase === 'observing') {
        this.updateActivityHeader(`\u25CE Observing\u2026 (step ${step + 1}/${maxSteps})`);
      }
    });

    this.on('taskStream', async (msg: AbjectMessage) => {
      const { ticketId, content } =
        msg.payload as { ticketId: string; content: string; done: boolean };
      if (!this._currentTicketId) return;
      if (ticketId && ticketId !== this._currentTicketId) return;
      // Don't render the raw text (it's mid-step reasoning + JSON actions),
      // but track the volume so the activity bubble can show the user that
      // the LLM is actively generating output.
      this._streamBuffer += content;
      this.stepStreamChars += content.length;
      this.scheduleActivityRefresh();
    });

    this.on('progress', async (msg: AbjectMessage) => {
      // Reset pending ticket + task completion timeouts on any progress signal.
      // The progress text itself is now surfaced through the liveGoals tree
      // (via goalUpdated events), so nothing to render here directly.
      this.resetPendingTicketTimeouts();
      this.resetTaskCompletionTimeouts();
      const { message } = msg.payload as { phase?: string; message?: string };
      if (!this._currentTicketId || !message) return;
    });

    // ── AgentAbject callback handlers ──

    this.on('agentObserve', async (_msg: AbjectMessage) => {
      return { observation: '' };
    });

    this.on('agentAct', (msg: AbjectMessage) => {
      const { action } = msg.payload as { taskId: string; step: number; action: AgentAction };
      this.handleAgentAct(action).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.sendDeferredReply(msg, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return DEFERRED_REPLY;
    });

    this.on('agentPhaseChanged', async (msg: AbjectMessage) => {
      const { step, newPhase, action } =
        msg.payload as { taskId: string; step: number; oldPhase: string; newPhase: string; action?: string };

      if (!this.activityBubbleLabelId) return;
      if (newPhase === 'thinking') {
        this.updateActivityStep(step + 1);
      }
      // 'acting' transitions surface through the liveGoals tree once the
      // action's goal lifecycle events fire — no flat activity-line needed.
    });

    this.on('agentIntermediateAction', async (msg: AbjectMessage) => {
      const { action } = msg.payload as { taskId: string; action: AgentAction };

      // Handle 'reply' intermediate action — show text as a proper assistant
      // bubble, then re-prime the activity bubble for the next step.
      if (action.action === 'reply') {
        const text = (action.text as string) ?? '';
        if (text) {
          this._streamBuffer = '';
          await this.removeActivityBubble();
          await this.appendBubble('assistant', 'Agent', text, true);
          this.conversationHistory.push({ role: 'assistant', content: text });
          this.schedulePersist();
          await this.showActivityBubble();
        }
      }
    });

    this.on('agentActionResult', async (_msg: AbjectMessage) => {
      // Goal-shaped actions surface their success/failure through
      // goalCompleted / goalFailed events into the liveGoals tree.
      // Non-goal actions (remember, reply, done) are reflected in the
      // chat history directly. Nothing to render here.
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Ticket helpers
  // ═══════════════════════════════════════════════════════════════════

  private waitForTaskResult(ticketId: string, timeoutMs: number): Promise<{
    ticketId: string; success: boolean; result?: unknown; error?: string;
    steps: number; maxStepsReached?: boolean; validationErrors?: string[];
  }> {
    type TaskResult = { ticketId: string; success: boolean; result?: unknown; error?: string; steps: number; maxStepsReached?: boolean; validationErrors?: string[] };
    return new Promise<TaskResult>((resolve, reject) => {
      const makeTimer = () => setTimeout(() => {
        this.pendingTickets.delete(ticketId);
        reject(new Error(`Task ${ticketId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const entry = {
        timeoutMs,
        timer: makeTimer(),
        resolve: (v: unknown) => { clearTimeout(entry.timer); this.pendingTickets.delete(ticketId); resolve(v as TaskResult); },
        reject: (e: Error) => { clearTimeout(entry.timer); this.pendingTickets.delete(ticketId); reject(e); },
      };
      this.pendingTickets.set(ticketId, entry);
    });
  }

  /** Reset all pending ticket timeouts (called on progress events). */
  private resetPendingTicketTimeouts(): void {
    for (const [ticketId, entry] of this.pendingTickets) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        this.pendingTickets.delete(ticketId);
        entry.reject(new Error(`Task ${ticketId} timed out after ${entry.timeoutMs}ms`));
      }, entry.timeoutMs);
    }
  }

  /**
   * Wait for a TupleSpace task to complete or fail via GoalManager events.
   * Resolves with { taskId, result } or rejects with error.
   */
  private waitForTaskCompletion(taskId: string, timeoutMs: number): Promise<{ taskId: string; result?: unknown }> {
    log.info(`[Chat] waitForTaskCompletion ${taskId.slice(0, 8)} timeout=${timeoutMs}ms pendingCount=${this.pendingTaskCompletions.size}`);
    return new Promise<{ taskId: string; result?: unknown }>((resolve, reject) => {
      const makeTimer = () => setTimeout(() => {
        this.pendingTaskCompletions.delete(taskId);
        log.info(`[Chat] waitForTaskCompletion ${taskId.slice(0, 8)} — TIMED OUT after ${timeoutMs}ms`);
        reject(new Error(`Task ${taskId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const entry = {
        timer: makeTimer(),
        timeoutMs,
        resolve: (v: unknown) => {
          clearTimeout(entry.timer);
          log.info(`[Chat] waitForTaskCompletion ${taskId.slice(0, 8)} — RESOLVED`);
          resolve(v as { taskId: string; result?: unknown });
        },
        reject: (e: Error) => {
          clearTimeout(entry.timer);
          log.info(`[Chat] waitForTaskCompletion ${taskId.slice(0, 8)} — REJECTED: ${e.message?.slice(0, 80)}`);
          reject(e);
        },
      };
      this.pendingTaskCompletions.set(taskId, entry);
    });
  }

  /** Reset all pending task completion timeouts (called on progress events). */
  private resetTaskCompletionTimeouts(): void {
    for (const [taskId, entry] of this.pendingTaskCompletions) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        this.pendingTaskCompletions.delete(taskId);
        log.info(`[Chat] waitForTaskCompletion ${taskId.slice(0, 8)} — TIMED OUT after ${entry.timeoutMs}ms`);
        entry.reject(new Error(`Task ${taskId} timed out after ${entry.timeoutMs}ms`));
      }, entry.timeoutMs);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Agent act handler
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Lazily create a goal on first action, using the action's description
   * as the title instead of the raw user query.
   */
  private async ensureGoal(description: string): Promise<string | undefined> {
    if (this._currentGoalId) return this._currentGoalId;
    if (!this.goalManagerId) return undefined;
    try {
      const { goalId } = await this.request<{ goalId: string }>(
        request(this.id, this.goalManagerId, 'createGoal', {
          title: description.slice(0, 100),
        })
      );
      this._currentGoalId = goalId;
      return goalId;
    } catch { return undefined; }
  }

  private async handleAgentAct(action: AgentAction): Promise<unknown> {
    log.info(`[Chat] handleAgentAct: action=${action.action}`);

    // Handle remember action directly (no agent dispatch needed)
    if (action.action === 'remember') {
      const knowledgeBaseId = await this.discoverDep('KnowledgeBase');
      if (!knowledgeBaseId) return { success: false, error: 'KnowledgeBase not available' };
      try {
        const result = await this.request(
          request(this.id, knowledgeBaseId, 'remember', {
            title: action.title as string ?? action.description as string ?? 'Untitled',
            content: action.content as string ?? action.description as string ?? '',
            type: (action.type as string) ?? 'fact',
            tags: (action.tags as string[]) ?? [],
          }),
          10000,
        );
        log.info(`[Chat] remembered: "${action.title ?? action.description}"`);
        return { success: true, data: result };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // Handle goal action: create goal + tasks, wait for completion
    if (action.action === 'goal') {
      const title = (action.title as string) ?? 'Untitled goal';
      const tasks = (action.tasks as Array<{
        description: string;
        data?: Record<string, unknown>;
        dependsOn?: number[];
        produces?: Array<{ key: string; description: string }>;
        consumes?: string[];
      }>) ?? [];
      if (tasks.length === 0) {
        return { success: false, error: 'Goal has no tasks' };
      }

      if (!this.goalManagerId) {
        return { success: false, error: 'GoalManager not available' };
      }

      const goalId = await this.ensureGoal(title);
      if (!goalId) {
        return { success: false, error: 'Failed to create goal' };
      }

      try {
        // Add all tasks to the goal. Default is SEQUENTIAL: each task auto-depends
        // on the previous one unless dependsOn is explicitly specified (including
        // dependsOn: [] for explicit parallel execution).
        const taskIds: string[] = [];
        for (let i = 0; i < tasks.length; i++) {
          const task = tasks[i];
          let depIds: string[];
          if (task.dependsOn === undefined) {
            // Default: auto-chain to previous task for sequential execution
            depIds = i > 0 ? [taskIds[i - 1]] : [];
          } else {
            // Explicit: map index-based dependsOn to task IDs (empty array allowed)
            depIds = task.dependsOn
              .filter(idx => idx >= 0 && idx < taskIds.length)
              .map(idx => taskIds[idx]);
          }

          const { taskId } = await this.request<{ taskId: string }>(
            request(this.id, this.goalManagerId, 'addTask', {
              goalId,
              description: task.description,
              data: task.data,
              dependsOn: depIds.length > 0 ? depIds : undefined,
              produces: task.produces,
              consumes: task.consumes,
            })
          );
          taskIds.push(taskId);
        }

        // Wait for all tasks to complete. Track whether any task failed so
        // we can still surface the diagnostic results from the ones that
        // succeeded — critical for the "diagnose then fix" pattern where
        // a diagnosis completes but the fix stalls.
        const results: unknown[] = [];
        let taskWaitError: Error | undefined;
        for (const taskId of taskIds) {
          try {
            const completion = await this.waitForTaskCompletion(taskId, 120000);
            const result = completion.result as Record<string, unknown> | undefined;

            // Auto-show created objects
            if (result?.objectId) {
              this.send(event(this.id, result.objectId as AbjectId, 'show', {}));
            }
            results.push(result);
          } catch (err) {
            taskWaitError = err instanceof Error ? err : new Error(String(err));
            results.push({ success: false, error: taskWaitError.message });
            // Don't wait for remaining tasks — a timeout usually means the
            // whole dispatch chain is stuck. Pull the scratchpad and return.
            break;
          }
        }

        // Always pull the goal scratchpad. GoalManager auto-mirrors every
        // completed task's result into `tasks/{id}/result`, so this gives
        // Chat's next think-step access to successful diagnostics even when
        // a later fix task timed out. Without this, the LLM synthesising
        // the user-facing reply loses the correct findings and hallucinates
        // generic "the system is timing out" messages.
        let scratchpad: Record<string, unknown> | undefined;
        try {
          const goal = await this.request<{ scratchpad?: Record<string, unknown> } | null>(
            request(this.id, this.goalManagerId, 'getGoal', { goalId }),
            5000,
          );
          scratchpad = goal?.scratchpad;
        } catch { /* best effort — scratchpad is a nice-to-have */ }

        const failures = results.filter(r => r && (r as Record<string, unknown>).success === false);
        if (failures.length > 0 || taskWaitError) {
          const errors = failures.map(f => (f as Record<string, unknown>).error ?? 'Unknown error');
          if (taskWaitError) errors.push(taskWaitError.message);
          return {
            success: false,
            error: errors.join('; '),
            data: { results, scratchpad, partial: true },
          };
        }
        return {
          success: true,
          data: results.length === 1
            ? { result: results[0], scratchpad }
            : { results, scratchpad },
        };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    return { success: false, error: `Unknown action: ${action.action}` };
  }

  // ═══════════════════════════════════════════════════════════════════
  // System prompt
  // ═══════════════════════════════════════════════════════════════════

  private buildSystemPrompt(): string {
    const now = new Date();
    const dateLine = now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const isoDate = now.toISOString().slice(0, 10);
    return `You are Chat Agent, a helpful assistant inside the Abjects system. You help users by creating goals and routing tasks to specialized agents.

Current date: ${dateLine} (${isoDate}). When the user mentions relative times ("today", "tomorrow", "next week", "in 3 days"), resolve them against this date.

## System Architecture

Abjects is a distributed message-passing system. Each Abject is an autonomous object with a manifest (declaring methods and events), a mailbox, and message handlers. Objects communicate exclusively via messages. They discover each other via Registry and coordinate via the observer pattern (addDependent -> changed events).

## Action Format

Respond with ONE action as a JSON object in a \`\`\`json code block. Include brief reasoning before the block.

\`\`\`json
{ "action": "done", "text": "Hello! How can I help you?" }
\`\`\`

## Available Actions

### Agent Work
- **goal**: Create a goal with one or more tasks for specialized agents to handle. Describe each task clearly so the right agent self-selects based on what it can do.
  Simple request (one task):
  \`{ "action": "goal", "title": "Fix the HackerNews UI", "tasks": [
    { "description": "Fix the UI of the HackerNews object: improve layout spacing, make the story list scrollable, fix text overflow" }
  ] }\`
  **Tasks run SEQUENTIALLY by default** — each task waits for the previous one to finish. Most multi-step work has natural ordering (fetch then summarize, discover then modify), so sequential is safest.
  Sequential (default):
  \`{ "action": "goal", "title": "Fetch and summarize", "tasks": [
    { "description": "Fetch the latest news headlines" },
    { "description": "Summarize the fetched headlines into a brief report" }
  ] }\`
  Explicit dependency (task 2 depends on task 0 but not task 1):
  \`{ "action": "goal", "title": "Research and report", "tasks": [
    { "description": "Research topic A" },
    { "description": "Research topic B" },
    { "description": "Combine findings", "dependsOn": [0, 1] }
  ] }\`
  Opt-in parallel (use \`dependsOn: []\` when you KNOW tasks are independent):
  \`{ "action": "goal", "title": "Independent lookups", "tasks": [
    { "description": "Fetch weather for Miami", "dependsOn": [] },
    { "description": "Fetch weather for NYC", "dependsOn": [] }
  ] }\`
  Use \`dependsOn: []\` ONLY when tasks truly have no dependencies and can safely run at the same time. When in doubt, leave dependsOn unspecified (sequential).
  Include the object name in the task description when relevant. Be specific about the desired outcome.

  **Scratchpad contracts for data handoff (investigate-then-fix, fetch-then-summarize, and similar chains)**

  When a downstream task needs structured data from an upstream task, declare the contract so the data flows reliably even when results are large. Add \`produces\` to the upstream task (each entry is \`{ key, description }\` describing the value shape) and \`consumes\` to the downstream task (the keys to read). The downstream agent sees the full values in its system prompt; the upstream agent is told to write them with \`writeGoalData\` before reporting done.

  Investigate-then-fix:
  \`{ "action": "goal", "title": "Diagnose and fix auth bug", "tasks": [
    {
      "description": "Investigate the auth failure. Find file, line, and root cause.",
      "produces": [{
        "key": "bug_analysis",
        "description": "{ file: string, line: number, rootCause: string, suggestedFix: string }"
      }]
    },
    {
      "description": "Apply the fix documented at scratchpad key bug_analysis.",
      "consumes": ["bug_analysis"],
      "dependsOn": [0]
    }
  ] }\`

  Fetch-then-summarize:
  \`{ "action": "goal", "title": "Summarize today's headlines", "tasks": [
    {
      "description": "Fetch the current top 20 news headlines with URL, title, and source.",
      "produces": [{
        "key": "headlines",
        "description": "Array of { title: string, url: string, source: string }"
      }]
    },
    {
      "description": "Write a one-paragraph summary of the day's top stories using the headlines at scratchpad key headlines.",
      "consumes": ["headlines"],
      "dependsOn": [0]
    }
  ] }\`

  Use contracts when task 1 depends on structured output from task 0. For simple chains where a short string result is enough, omit \`produces\`/\`consumes\` and the existing Goal Progress block carries the result verbatim.

  Concrete user data (email, calendar, files, contacts, weather, web pages, finances, etc.):
  ALWAYS attempt via a goal — specialized agents and MCP-backed skills may be available that you don't know about.
  \`{ "action": "goal", "title": "Latest email", "tasks": [
    { "description": "Fetch the user's most recent email and report the sender, subject, received time, and a short summary of the body" }
  ] }\`

### Memory
- **remember**: Save a fact to the persistent knowledge base. Use whenever the user reveals personal info or you learn something useful for future conversations.
  \`{ "action": "remember", "title": "User lives in Silverdale, WA", "content": "The user mentioned they live in Silverdale, Washington.", "type": "fact", "tags": ["user", "location"] }\`
  Types: 'fact' (personal info, discovered truths), 'learned' (lessons from outcomes), 'insight' (patterns), 'reference' (pointers)

### Communication
- **clarify**: Ask the user a clarifying question before proceeding. Use when your assumptions
  about their request have low confidence. The user will see your question and respond.
  \`{ "action": "clarify", "question": "Did you mean X or Y?", "assumptions": [
    { "assumption": "User wants to modify the existing Counter", "confidence": "high" },
    { "assumption": "The reset should set count to zero", "confidence": "low" }
  ] }\`
- **reply**: Send intermediate text to the user (continue working after).
  \`{ "action": "reply", "text": "Working on it, I've created the goal..." }\`
- **done**: Task complete, send final reply. The user can only see what you put in the done text.
  \`{ "action": "done", "text": "Here are the results: ..." }\`
  When the goal returned a result, present it to the user in full. You have plenty of output tokens (16K+) to include everything. Format the result for readability: markdown tables, lists, headers as appropriate. Rephrase or translate raw data (JSON, logs) into natural language when it helps the user. Include every item and every requested field. If the user asked for 5 items, show all 5. If the user asked for full content, show full content. Trust your output capacity; the result fits.

The chat window renders markdown. Use **bold**, *italic*, \`inline code\`, headings, bullet lists, code blocks, and [links](url) in your reply and done text for readable formatting.

## Scheduled and recurring work

Abjects has a dedicated primitive for "every N minutes do X", "at 6:30am daily do Y", and other time-driven automation. That primitive is a scheduled job: a piece of code that calls existing objects on an interval. It is the right shape when the user wants periodic execution of capabilities that already exist in the system.

Describe scheduled work as an outcome on a cadence and trust the dispatcher to route it to a handler that knows how to register the schedule. Examples:
- *"Every minute, check the telegram skill for new messages and post any from @mempko into this chat."*
- *"Every day at 6:30 AM Pacific, send a morning briefing to chat."*
- *"Once an hour, pull the latest issues from the GitHub skill and remember any that match my saved keywords."*

Reserve "create an agent" phrasing for requests that need a new LLM-driven decision loop: new judgement, new routing of future tasks, a new named entity visible to the user. Periodic execution of existing capabilities is lighter than that: a scheduled job suffices.

## Bridges, proxies, relays, adapters, integrations

When the user asks for a bridge, proxy, relay, adapter, or integration between two endpoints (chat and a messaging service, a skill and another system, two APIs), that is a single forwarding object. Describe it with the user's word ("proxy", "bridge", "relay", "adapter", "integration") and keep the task wording as an OBJECT, not an agent. A forwarding object has no LLM decision loop of its own; it moves traffic between endpoints and wraps a service.

Examples (preserve the user's terminology):
- User says "create a telegram proxy" → *"Create a Telegram proxy object that forwards chat messages to Telegram and relays incoming Telegram messages back into the chat as user input."*
- User says "build a calendar bridge" → *"Create a calendar bridge object that syncs events between Google Calendar and the local calendar object."*
- User says "make a slack relay" → *"Create a Slack relay object that forwards notifications from the workspace to the configured Slack channel."*

Use "Create a X proxy object" or "Create a X bridge object" in the task description so the dispatcher routes it to a creation agent that builds single forwarding objects. Keep the word the user chose rather than promoting it to "agent".

## Describe outcomes, let the system discover the path

Everything in Abjects is an Abject, discovered and queried through the registry. Write task descriptions at the capability level — state the outcome you want — and trust the system to route the task and locate the objects that hold the state.

Skill and MCP state (env vars, tokens, API keys, installed packages) lives inside the Abjects system itself. The agent that handles the task will discover the right object via the ask protocol and read or update the state through it. Your job is to describe what the user wants; the dispatcher and handling agent figure out where to look.

Templates:
- User asks "how do I configure the <X> skill?" → *"Report the current configuration for the <X> skill: which values are set, which are still missing, and how to set them."*
- User asks "list installed skills" → *"List every installed skill or MCP server with its status and the values it needs."*
- User asks "install <X>" → *"Install <X> and report whether any additional configuration is required."*

Keep task descriptions outcome-focused: what should be true when the task finishes. Leave implementation, locations, and tool choices to the handling agent.

## Writing Good Task Descriptions

Task descriptions are how agents decide whether they can handle a task. Describe WHAT needs to happen, not HOW to do it. Agents already know their own tools, APIs, credentials, and connection details. Including implementation details (ports, protocols, libraries, connection strings) or notes about past failures in task descriptions confuses agent routing. Each attempt starts fresh; agents handle their own error recovery.
- Include the object name when the task involves an existing object (e.g., "Modify the HackerNews object to..." not just "Fix the UI")
- Describe the desired outcome, not just the problem (e.g., "Add a reset button to the Counter that sets the count back to zero")
- For web tasks, mention that it involves a real website (e.g., "Browse https://example.com and extract the article text")
- For new functionality, describe what it should do without dictating how (e.g., "Display a todo list with add, remove, and mark-complete functionality")
- Match the word the user chose to the intent, and preserve it in the task description. "Create an agent that..." fits when the user asks for a new LLM-driven decision loop that registers with the system and handles future tasks on its own. "Check X every minute" on its own is recurring execution (a scheduled job, see the Scheduled section above). "Create a proxy / bridge / relay / adapter / integration" is a single forwarding object (see the Bridges section above). Preserve the user's word choice instead of promoting a proxy or scheduled job to "agent".
- Describe the desired behavior and let the system decide the implementation. Prefer "Display a morning briefing in chat every day at 10am" over "Create an Abjects object called MorningBriefing that uses setInterval..."

## Assumption Checking

Before creating a goal, consider what assumptions you are making. For each assumption, estimate your confidence (high/medium/low).

If ANY assumption has low confidence, use **clarify** first.

Examples of assumptions to check:
- Which existing object the user is referring to (if ambiguous)
- What specific behavior or appearance the user wants
- Whether the user wants a new object or a change to an existing one

You do not need to clarify simple greetings, direct questions, or unambiguous requests.

## Rules

1. Always respond with valid JSON in a \`\`\`json block. ONE action per response. Never reply with bare prose — even your final answer must be wrapped in \`{ "action": "done", "text": "..." }\`.
2. For simple greetings, use **done** directly. For questions about objects or the system, create a **goal** to investigate rather than guessing. You do not have knowledge of what objects exist or what they can do. Always use the system to find out.
3. When the user asks you to do something, create a **goal** immediately with well-described tasks.
4. **Never refuse based on assumed capabilities.** You don't have a fixed toolset — agents and MCP-backed skills are added and removed dynamically (email, calendar, contacts, finance, web, etc.). If the user asks for concrete data or an action, ALWAYS try via a goal first. Only say "I can't" AFTER the goal has actually failed, and even then, offer to create an agent that could.
5. Always end a conversation turn with **done** when the task is complete.
6. Keep reasoning brief (1-2 sentences before the JSON block).
7. If a goal's tasks fail, you can retry by creating a new goal with a simpler task description. If it fails repeatedly, use "done" to tell the user what happened — quoting the actual failure message, not a guess.

## Stop when the work is done

When the user asked for an object, app, widget, bridge, tool, schedule, or agent and the goal finishes successfully, the work is done. The object is registered; the user can discover and open it from the taskbar, AppExplorer, or by asking. On the very next turn, call **done** with:
- the object's name exactly as registered,
- a one-line summary of what it does,
- how to open it (taskbar, AppExplorer, or "ask me to open it").

Treat the user's silence as confirmation. Wait for the user to report a specific issue before revisiting the object — their feedback is the signal to retry or refine.

Save method-call follow-ups (show, hide, refresh, update) for turns when the user explicitly asks. If the user says "open it" or "show me X" or "run X", then create a goal whose task description names the target object and the method, e.g. *"Call show() on the FooWidget object to open its window"*.

A single successful creation goal is a complete turn. End it with **done**.
8. P2P: Resolve remote objects by qualified name: this.find('peer.workspace.ObjectName'). Always use find() for dynamic ID resolution.
9. When the user reveals personal facts (where they live, their name, preferences, job, etc.), save them using **remember** so you can recall them in future conversations.
10. Task descriptions should describe the desired outcome and timing, letting agents decide implementation. Example: "Post a weather briefing to chat every day at 10:30 AM" is better than "Use setInterval to check the time every minute".`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Chat-specific logic
  // ═══════════════════════════════════════════════════════════════════

  async show(): Promise<boolean> {
    if (this.windowId) {
      try {
        await this.request(request(this.id, this.widgetManagerId!, 'raiseWindow', {
          windowId: this.windowId,
        }));
      } catch { /* best effort */ }
      return true;
    }

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );

    let winW: number;
    let winH: number;
    let winX: number;
    let winY: number;
    if (this.initialRect) {
      winW = Math.min(this.initialRect.width, displayInfo.width - 20);
      winH = Math.min(this.initialRect.height, displayInfo.height - 20);
      winX = Math.max(10, Math.min(this.initialRect.x, displayInfo.width - winW - 10));
      winY = Math.max(10, Math.min(this.initialRect.y, displayInfo.height - winH - 10));
    } else {
      winW = Math.min(DEFAULT_WIN_W, Math.max(360, displayInfo.width - 40));
      winH = Math.min(DEFAULT_WIN_H, Math.max(360, displayInfo.height - 40));
      winX = Math.max(20, Math.floor((displayInfo.width - winW) / 2));
      winY = Math.max(20, Math.floor((displayInfo.height - winH) / 2));
    }
    this.currentWindowWidth = winW;
    this.currentRect = { x: winX, y: winY, width: winW, height: winH };

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: this.formatWindowTitle(this.conversationTitle),
        rect: { x: winX, y: winY, width: winW, height: winH },
        zIndex: 200,
        resizable: true,
      })
    );

    // Subscribe to the window for windowResized events.
    this.send(request(this.id, this.windowId, 'addDependent', {}));

    // Root VBox: message log stacked over composer column.
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: this.theme.tokens.space.md, right: this.theme.tokens.space.lg, bottom: this.theme.tokens.space.md, left: this.theme.tokens.space.lg },
        spacing: this.theme.tokens.space.md,
      })
    );

    // Scrollable VBox for message log (expanding, auto-scroll to follow new messages).
    this.messageLogId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        autoScroll: true,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: this.theme.tokens.space.md,
      })
    );

    // Composer column: input row on top, hint label under it.
    this.composerColumnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: this.theme.tokens.space.xs,
      })
    );

    // Input row (HBox: TextInput + Send button).
    this.composerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.composerColumnId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: this.theme.tokens.space.md,
      })
    );
    this.inputRowId = this.composerRowId;

    // Assemble root: message log (expanding) + composer column (preferred).
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.messageLogId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.composerColumnId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' }, preferredSize: { height: INPUT_MIN_HEIGHT + this.theme.tokens.space.xs + this.theme.tokens.space.xl } },
      ],
    }));

    // Composer widgets: text input, send button (circular glyph), hint label.
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          {
            type: 'textInput', windowId: this.windowId,
            placeholder: 'Message the agent\u2026',
            wordWrap: true, maxLines: 6,
          },
          {
            type: 'button', windowId: this.windowId, text: SEND_GLYPH,
            style: {
              background: this.theme.actionBg,
              color: this.theme.actionText,
              borderColor: this.theme.actionBorder,
              radius: SEND_BTN_SIZE / 2,
              fontSize: 18,
            },
          },
          {
            type: 'label', windowId: this.windowId,
            text: '\u21B5  Send   \u00B7   \u21E7\u21B5  Newline',
            style: {
              color: this.theme.textTertiary,
              fontSize: 11,
              wordWrap: false,
              selectable: false,
              align: 'right' as const,
            },
          },
        ],
      })
    );
    this.textInputId = widgetIds[0];
    this.sendBtnId = widgetIds[1];
    this.composerHintLabelId = widgetIds[2];

    // Add input + send button to the composer row.
    await this.request(request(this.id, this.composerRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.textInputId, sizePolicy: { horizontal: 'expanding' }, preferredSize: { height: INPUT_MIN_HEIGHT } },
        { widgetId: this.sendBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: SEND_BTN_SIZE, height: SEND_BTN_SIZE } },
      ],
    }));

    // Add hint label below the input row.
    await this.request(request(this.id, this.composerColumnId, 'addLayoutChildren', {
      children: [
        { widgetId: this.composerRowId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' }, preferredSize: { height: INPUT_MIN_HEIGHT } },
        { widgetId: this.composerHintLabelId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' }, preferredSize: { height: this.theme.tokens.space.xl } },
      ],
    }));

    // Fire-and-forget: register as dependent of interactive widgets.
    this.send(request(this.id, this.sendBtnId, 'addDependent', {}));
    this.send(request(this.id, this.textInputId, 'addDependent', {}));

    this.uiPhase = 'idle';

    log.info(`[Chat ${(this.conversationId ?? this.id).slice(0, 8)}] show() historyLen=${this.conversationHistory.length} title="${this.conversationTitle ?? ''}"`);
    if (this.conversationHistory.length === 0) {
      // Fresh conversation — show the welcome card + suggestion chips.
      await this.showWelcomeState();
    } else {
      // Restored from persistence — re-render each past message as a bubble.
      await this.renderHistoryBubbles();
    }

    this.changed('visibility', true);
    return true;
  }

  /**
   * Re-render `conversationHistory` as bubbles. Called on show() when the
   * conversation already has persisted messages (rehydrated from Storage).
   * Bubbles are emitted silently so downstream subscribers do not treat
   * historical messages as new arrivals.
   */
  private async renderHistoryBubbles(): Promise<void> {
    for (const entry of this.conversationHistory) {
      const role: BubbleRole =
        entry.role === 'user' ? 'user' :
        entry.role === 'assistant' ? 'assistant' : 'system';
      const sender =
        entry.role === 'user' ? 'You' :
        entry.role === 'assistant' ? 'Agent' : 'System';
      const markdown = entry.role !== 'user';
      await this.appendBubble(role, sender, entry.content, markdown, /* silent */ true);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Welcome state
  // ═══════════════════════════════════════════════════════════════════

  private async showWelcomeState(): Promise<void> {
    if (!this.messageLogId || !this.windowId) return;
    if (this.welcomeWidgetIds.length > 0) return;

    const welcomeText = '\u2728  **Welcome to Chat**\n\nAbjects is a distributed object system where everything is an Abject: autonomous objects that communicate via messages, discover each other through a Registry, and coordinate work through goals and agents. Ask me to explore what objects exist, create new ones, fetch your email, or anything else. Specialized agents will pick up the work automatically.';
    const bubbleMaxWidth = this.computeBubbleMaxWidth();
    const innerWidth = bubbleMaxWidth - this.theme.tokens.space.xs * 2;
    const height = this.estimateBubbleHeight(welcomeText, innerWidth, true);

    const specs: Array<Record<string, unknown>> = [
      {
        type: 'label', windowId: this.windowId, text: welcomeText,
        style: {
          color: this.theme.textPrimary,
          background: lightenColor(this.theme.windowBg, 6),
          radius: this.theme.tokens.radius.lg,
          fontSize: 13,
          wordWrap: true,
          selectable: false,
          markdown: true,
          align: 'center' as const,
        },
      },
    ];
    for (const chip of DEFAULT_SUGGESTIONS) {
      specs.push({
        type: 'button', windowId: this.windowId, text: chip.label,
        style: {
          background: lightenColor(this.theme.windowBg, 12),
          color: this.theme.textPrimary,
          borderColor: darkenColor(this.theme.windowBg, -12),
          radius: 18,
          fontSize: 12,
        },
      });
    }

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs })
    );
    const welcomeLabelId = widgetIds[0];
    const chipIds = widgetIds.slice(1);

    await this.request(request(this.id, this.messageLogId, 'addLayoutChild', {
      widgetId: welcomeLabelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: bubbleMaxWidth, height },
      alignment: 'center',
    }));
    this.welcomeWidgetIds.push(welcomeLabelId);
    this.messageLabelIds.push(welcomeLabelId);

    for (const chipId of chipIds) {
      await this.request(request(this.id, this.messageLogId, 'addLayoutChild', {
        widgetId: chipId,
        sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
        preferredSize: { width: Math.min(bubbleMaxWidth, 360), height: 32 },
        alignment: 'center',
      }));
      this.welcomeWidgetIds.push(chipId);
      this.messageLabelIds.push(chipId);
      this.send(request(this.id, chipId, 'addDependent', {}));
    }
  }

  private async removeWelcomeState(): Promise<void> {
    if (this.welcomeWidgetIds.length === 0) return;
    const ids = [...this.welcomeWidgetIds];
    this.welcomeWidgetIds = [];
    for (const id of ids) {
      await this.removeLabel(id);
    }
  }

  /** Map a chip button's text back to the full prompt it should send. */
  private promptForChipText(chipText: string): string | undefined {
    const chip = DEFAULT_SUGGESTIONS.find(c => c.label === chipText);
    return chip?.prompt;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    this.uiPhase = 'closed';

    // Flush any pending history persist before the window goes away
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      void this.persistHistory();
    }

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.messageLogId = undefined;
    this.inputRowId = undefined;
    this.composerRowId = undefined;
    this.composerColumnId = undefined;
    this.composerHintLabelId = undefined;
    this.textInputId = undefined;
    this.sendBtnId = undefined;
    this.messageLabelIds = [];
    this.messageMetadata.clear();
    this.bubbleSenderLabels.clear();
    this.activityBubbleLabelId = undefined;
    this.activityStep = 0;
    this.liveGoals.clear();
    this.liveTasks.clear();
    this.welcomeWidgetIds = [];
    this._streamBuffer = '';
    if (this.activityRefreshTimer) {
      clearTimeout(this.activityRefreshTimer);
      this.activityRefreshTimer = undefined;
    }
    if (this.reflowTimer) {
      clearTimeout(this.reflowTimer);
      this.reflowTimer = undefined;
    }
    this.changed('visibility', false);
    return true;
  }

  // ─── Conversation identity helpers ──────────────────────────────────

  private formatWindowTitle(title?: string): string {
    const t = (title ?? this.conversationTitle ?? 'Chat').trim();
    return `\uD83D\uDCAC  ${t || 'Chat'}`;
  }

  private notifyRectChanged(): void {
    if (!this.currentRect || !this.chatManagerId || !this.conversationId) return;
    if (this.rectPersistTimer) return;
    this.rectPersistTimer = setTimeout(() => {
      this.rectPersistTimer = undefined;
      if (!this.currentRect || !this.chatManagerId || !this.conversationId) return;
      this.send(event(this.id, this.chatManagerId, 'rectChanged', {
        conversationId: this.conversationId,
        rect: { ...this.currentRect },
      }));
    }, 250);
  }

  private schedulePersist(): void {
    if (!this.conversationId || !this.storageId) return;
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistHistory();
    }, 200);
  }

  private async persistHistory(): Promise<void> {
    if (!this.conversationId || !this.storageId) return;
    try {
      await this.request(request(this.id, this.storageId, 'set', {
        key: `chats:history:${this.conversationId}`,
        value: this.conversationHistory,
      }));
    } catch { /* best effort */ }
  }

  /**
   * Auto-derive a title from the first user message. No-op if the user or a
   * caller has already given the conversation a non-default title.
   */
  private maybeAutoTitle(userText: string): void {
    if (!this.conversationId) return;
    const current = (this.conversationTitle ?? '').trim();
    if (current && current !== 'New chat') return;
    const cleaned = userText.replace(/\s+/g, ' ').trim();
    if (!cleaned) return;
    const derived = cleaned.length > 40 ? cleaned.slice(0, 40).trimEnd() + '\u2026' : cleaned;
    this.conversationTitle = derived;
    if (this.windowId) {
      try {
        this.send(request(this.id, this.windowId, 'setTitle', {
          title: this.formatWindowTitle(derived),
        }));
      } catch { /* best effort */ }
    }
    if (this.chatManagerId) {
      this.send(event(this.id, this.chatManagerId, 'titleChanged', {
        conversationId: this.conversationId,
        title: derived,
      }));
    }
  }

  private async handleSendClick(): Promise<void> {
    if (this.uiPhase !== 'idle' || !this.textInputId) return;

    const text = await this.request<string>(
      request(this.id, this.textInputId, 'getValue', {})
    );

    if (!text?.trim()) return;

    // Clear input
    await this.request(
      request(this.id, this.textInputId, 'update', { text: '' })
    );

    this.triggerSend(text.trim());
  }

  private triggerSend(text: string): void {
    if (this.uiPhase !== 'idle') return;
    this.runChatTask(text);
  }

  private async runChatTask(userText: string): Promise<void> {
    if (this.uiPhase === 'closed') return;
    this.uiPhase = 'busy';
    await this.setInputDisabled(true);
    // Long-op accent halo on the send button so the user sees the agent is
    // working even when the activity bubble scrolls off-screen (Doherty).
    if (this.sendBtnId) {
      try { this.send(event(this.id, this.sendBtnId, 'update', { busy: true })); } catch { /* widget gone */ }
    }
    await this.removeWelcomeState();

    // Show user message as a right-aligned bubble. User input is plain text —
    // render it without markdown so the wordwrap path honors right alignment
    // inside the bubble.
    await this.appendBubble('user', 'You', userText, false);
    this.conversationHistory.push({ role: 'user', content: userText });
    this.schedulePersist();
    this.maybeAutoTitle(userText);

    // Show consolidated activity bubble for the run.
    await this.showActivityBubble();

    try {
      // Build initial messages: system prompt + conversation history + new user message
      const initialMessages: { role: string; content: string }[] = [];
      const recent = this.conversationHistory.slice(-MAX_CONVERSATION_ENTRIES);
      for (const entry of recent) {
        initialMessages.push({ role: entry.role, content: entry.content });
      }

      // Goal is created lazily on first action via ensureGoal(),
      // using the action's description instead of the raw user query.
      this._currentGoalId = undefined;
      const goalId = undefined;

      // Submit task — returns ticketId immediately
      this._streamBuffer = '';
      const { ticketId } = await this.request<{ ticketId: string }>(
        request(this.id, this.agentAbjectId!, 'startTask', {
          task: userText,
          systemPrompt: this.buildSystemPrompt(),
          initialMessages,
          goalId,
          config: { queueName: `chat-${this.id}` },
        }),
        60000,
      );
      this._currentTicketId = ticketId;

      // Wait for taskResult event
      const result = await this.waitForTaskResult(ticketId, 180000);
      this._currentTicketId = undefined;
      this._currentGoalId = undefined;

      // Post-task UI cleanup.
      await this.removeActivityBubble();

      if (result.success) {
        const text = (result.result as string) ?? '';
        if (text) {
          await this.appendBubble('assistant', 'Agent', text, true);
          this.conversationHistory.push({ role: 'assistant', content: text });
          this.schedulePersist();
        }
      } else {
        const errorText = (result.error ?? 'Unknown error').slice(0, 200);
        const note = result.maxStepsReached ? ' (step limit reached)' : '';
        await this.appendBubble('error', 'Error', errorText + note, false);
        await this.notify(
          result.maxStepsReached ? 'Agent stopped: step limit reached' : 'Agent error',
          'error',
        );
      }
    } catch (err) {
      this._currentTicketId = undefined;
      this._currentGoalId = undefined;
      await this.removeActivityBubble();
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.appendBubble('error', 'Error', errMsg.slice(0, 200), false);
      await this.notify(`Chat error: ${errMsg.slice(0, 80)}`, 'error');
    } finally {
      if (this.sendBtnId) {
        try { this.send(event(this.id, this.sendBtnId, 'update', { busy: false })); } catch { /* widget gone */ }
      }
    }

    this.uiPhase = this.windowId ? 'idle' : 'closed';
    if (this.windowId) await this.setInputDisabled(false);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Object Resolution
  // ═══════════════════════════════════════════════════════════════════

  private async resolveObject(name: string): Promise<AbjectId | null> {
    if (!this.registryId || !name) return null;

    // UUIDs are direct AbjectIds — use as-is
    if (name.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      return name as AbjectId;
    }

    // Everything else (names like "WebAgent", interface IDs like "abjects:web-agent")
    // gets resolved via Registry discovery
    try {
      const results = await this.request<Array<{ id: AbjectId }>>(
        request(this.id, this.registryId, 'discover', { name })
      );
      return results.length > 0 ? results[0].id : null;
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Context Refresh
  // ═══════════════════════════════════════════════════════════════════


  // ═══════════════════════════════════════════════════════════════════
  // UI Helpers
  // ═══════════════════════════════════════════════════════════════════

  private async setInputDisabled(disabled: boolean): Promise<void> {
    const style = { disabled };
    if (this.sendBtnId) {
      try { await this.request(request(this.id, this.sendBtnId, 'update', { style })); } catch { /* widget gone */ }
    }
    if (this.textInputId) {
      try { await this.request(request(this.id, this.textInputId, 'update', { style })); } catch { /* widget gone */ }
    }
  }

  // ── Bubble styling ───────────────────────────────────────────────────

  private bubbleStyleForRole(role: BubbleRole): { background: string; color: string; align: BubbleAlign; borderColor?: string } {
    switch (role) {
      case 'user':
        return {
          background: lightenColor(this.theme.windowBg, 18),
          color: this.theme.textPrimary,
          align: 'right',
          borderColor: darkenColor(this.theme.accentSecondary, 30),
        };
      case 'assistant':
        return {
          background: lightenColor(this.theme.windowBg, 8),
          color: this.theme.textPrimary,
          align: 'left',
        };
      case 'system':
        return {
          background: darkenColor(this.theme.windowBg, 4),
          color: this.theme.textSecondary,
          align: 'center',
        };
      case 'error':
        return {
          background: darkenColor(this.theme.statusError, 60),
          color: this.theme.statusError,
          align: 'left',
        };
      case 'activity':
        return {
          background: lightenColor(this.theme.windowBg, 6),
          color: this.theme.statusNeutral,
          align: 'left',
        };
    }
  }

  private computeAvailableWidth(): number {
    // Window content area = window width - side margins - scrollbar.
    return Math.max(BUBBLE_MIN_WIDTH, this.currentWindowWidth - this.theme.tokens.space.lg * 2 - 8);
  }

  private computeBubbleMaxWidth(): number {
    const available = this.computeAvailableWidth();
    return Math.min(available, Math.max(BUBBLE_MIN_WIDTH, Math.floor(available * BUBBLE_MAX_FRACTION)));
  }

  private formatTimestamp(ts: number): string {
    const delta = Date.now() - ts;
    if (delta < 60_000) return 'now';
    try {
      return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  }

  private shouldGroupWithPrevious(role: BubbleRole, sender: string): boolean {
    const last = this.lastContentMeta();
    if (!last) return false;
    return last.role === role && last.sender === sender && (Date.now() - last.ts) < GROUP_WINDOW_MS;
  }

  /** Returns the metadata for the most recent content label (skipping sender labels). */
  private lastContentMeta(): MessageMeta | undefined {
    for (let i = this.messageLabelIds.length - 1; i >= 0; i--) {
      const meta = this.messageMetadata.get(this.messageLabelIds[i]);
      if (meta) return meta;
    }
    return undefined;
  }

  private estimateBubbleHeight(text: string, innerWidth: number, markdown: boolean): number {
    const fontSize = 13;
    const lineHeight = fontSize + 4;
    const raw = markdown
      ? estimateMarkdownHeight(text, innerWidth, fontSize)
      : Math.max(lineHeight, estimateWrappedLineCount(text, innerWidth, fontSize) * lineHeight);
    return raw + this.theme.tokens.space.md;
  }

  /**
   * Append a styled "chat bubble" message to the log.
   * Optionally precedes the bubble with a small sender/timestamp label unless
   * grouping with the previous message (same role+sender within GROUP_WINDOW_MS).
   */
  private async appendBubble(
    role: BubbleRole,
    sender: string,
    text: string,
    markdown = false,
    silent = false,
  ): Promise<AbjectId> {
    if (!this.messageLogId || !this.windowId) return '' as AbjectId;

    // Notify subscribers (bridges, proxies, relays, integrations) that a new
    // durable message landed in the chat log. Skip the transient 'activity'
    // role since those bubbles represent in-progress agent status that mutates
    // continuously and is not part of the user-visible conversation record.
    // `silent` suppresses the event during history rehydration — those bubbles
    // are re-renders of past messages, not new arrivals.
    if (role !== 'activity' && !silent) {
      this.changed('messageAdded', {
        conversationId: this.conversationId ?? '',
        role,
        sender,
        text,
        markdown,
        at: Date.now(),
      });
    }

    const { background, color, align, borderColor } = this.bubbleStyleForRole(role);
    const bubbleMaxWidth = this.computeBubbleMaxWidth();
    const innerWidth = bubbleMaxWidth - this.theme.tokens.space.xs * 2;
    const bubbleHeight = this.estimateBubbleHeight(text, innerWidth, markdown);

    // Sender/timestamp mini-label (skipped when grouping).
    const shouldEmitSender = !!sender && !this.shouldGroupWithPrevious(role, sender);
    let senderLabelId: AbjectId | undefined;
    if (shouldEmitSender) {
      const headerText = `${sender}  \u00B7  ${this.formatTimestamp(Date.now())}`;
      const { widgetIds: [headerId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [
            {
              type: 'label', windowId: this.windowId, text: headerText,
              style: {
                color: this.theme.textTertiary,
                fontSize: 11,
                wordWrap: false,
                selectable: false,
                align,
              },
            },
          ],
        })
      );
      await this.request(request(this.id, this.messageLogId, 'addLayoutChild', {
        widgetId: headerId,
        sizePolicy: { vertical: 'fixed', horizontal: align === 'center' ? 'expanding' : 'fixed' },
        preferredSize: { height: SENDER_LABEL_HEIGHT, width: align === 'center' ? undefined : bubbleMaxWidth },
        alignment: align,
      }));
      this.messageLabelIds.push(headerId);
      senderLabelId = headerId;
      // Sender labels have no metadata entry — they are chrome, not content.
    }

    const { widgetIds: [labelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          {
            type: 'label', windowId: this.windowId, text,
            style: {
              color,
              fontSize: 13,
              wordWrap: true,
              selectable: true,
              markdown,
              background,
              radius: this.theme.tokens.radius.lg,
              borderColor,
              align,
            },
          },
        ],
      })
    );
    await this.request(request(this.id, this.messageLogId, 'addLayoutChild', {
      widgetId: labelId,
      sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
      preferredSize: { width: bubbleMaxWidth, height: bubbleHeight },
      alignment: align,
    }));
    this.messageLabelIds.push(labelId);
    this.messageMetadata.set(labelId, { role, sender, ts: Date.now(), text, markdown, align });
    if (senderLabelId) {
      this.bubbleSenderLabels.set(labelId, senderLabelId);
    }
    return labelId;
  }

  // ── Activity bubble (consolidated thinking + progress) ───────────────

  private async showActivityBubble(): Promise<void> {
    if (this.activityBubbleLabelId) return;
    this.activityStep = 0;
    this.activityHeader = '\u25CF Thinking\u2026';
    this.activityRefreshLastHeight = 0;
    this.stepStreamChars = 0;
    this.liveGoals.clear();
    this.liveTasks.clear();
    this.activityBubbleLabelId = await this.appendBubble('activity', 'Agent', this.activityHeader, false);
  }

  /** Fetch goal title from GoalManager when we lazily seed a goal entry. */
  private async fetchGoalTitle(goalId: string): Promise<void> {
    if (!this.goalManagerId) return;
    try {
      const goal = await this.request<{ id: string; title: string; parentId?: string; status: string } | null>(
        request(this.id, this.goalManagerId, 'getGoal', { goalId })
      );
      if (goal) {
        const entry = this.liveGoals.get(goalId);
        if (entry) {
          entry.title = goal.title;
          entry.parentId = goal.parentId;
          this.scheduleActivityRefresh();
        }
      }
    } catch { /* GoalManager may not be ready */ }
  }

  /** Fetch tasks for a goal from GoalManager and cache them. */
  private async fetchGoalTasks(goalId: string): Promise<void> {
    if (!this.goalManagerId) return;
    try {
      const tuples = await this.request<Array<{
        id: string; fields: Record<string, unknown>; claimedBy?: string;
      }>>(
        request(this.id, this.goalManagerId, 'getTasksForGoal', { goalId })
      );
      const tasks = (tuples ?? []).map(t => ({
        id: t.id,
        description: (t.fields?.description as string) ?? '',
        status: (t.fields?.status as string) ?? 'pending',
        agentName: (t.fields?.agentName as string) ?? undefined,
        claimedBy: t.claimedBy,
        attempts: (t.fields?.attempts as number) ?? 0,
        maxAttempts: (t.fields?.maxAttempts as number) ?? 3,
      }));
      this.liveTasks.set(goalId, tasks);
    } catch { /* GoalManager may not be ready */ }
  }

  private composeActivityText(): string {
    const baseHeader = this.activityStep > 0
      ? `\u25CF Thinking\u2026 (step ${this.activityStep}/${MAX_STEPS})`
      : this.activityHeader;
    // Append a streaming hint so the user sees the LLM is actively producing
    // output even when no other progress signal has fired yet. Approximate
    // tokens at ~4 chars/token.
    const header = this.stepStreamChars > 0
      ? `${baseHeader}  \u00B7  ~${Math.max(1, Math.round(this.stepStreamChars / 4))} tok streamed`
      : baseHeader;
    const tree = this.composeProgressTree();
    if (!tree) return header;
    return header + '\n' + tree;
  }

  /**
   * Render a Goals-viewer-style indented tree of the goals being worked on
   * for the current task. Walks from `_currentGoalId` down through any
   * descendant goals captured in `liveGoals`.
   */
  private composeProgressTree(): string {
    if (!this._currentGoalId || this.liveGoals.size === 0) return '';

    const lines: string[] = [];
    const visited = new Set<string>();

    const visit = (goalId: string, depth: number): void => {
      if (visited.has(goalId)) return;
      visited.add(goalId);
      const goal = this.liveGoals.get(goalId);
      if (!goal) return;

      // Goal title with status icon (matches GoalBrowser)
      const indent = '  '.repeat(depth);
      const goalIcon = goal.status === 'completed' ? '\u2713'   // ✓
                     : goal.status === 'failed'    ? '\u2717'   // ✗
                     : '\u25B8';                                // ▸
      lines.push(`${indent}${goalIcon} ${goal.title}`);

      // Render tasks under this goal
      const tasks = this.liveTasks.get(goalId);
      if (tasks && tasks.length > 0) {
        const taskIndent = '  '.repeat(depth + 1);
        for (const task of tasks) {
          // Pending + claimedBy → effectively "claimed"
          const effectiveStatus = task.status === 'pending' && task.claimedBy
            ? 'claimed' : task.status;

          const tIcon = effectiveStatus === 'done' ? '\u2713'                         // ✓
                      : effectiveStatus === 'permanently_failed' ? '\u2717'           // ✗
                      : effectiveStatus === 'claimed' || effectiveStatus === 'in_progress' ? '\u25D1'  // ◑
                      : '\u25CB';                                                     // ○

          const agent = task.agentName ? `[${task.agentName}] ` : '';
          const attempts = task.attempts > 0 ? ` (${task.attempts}/${task.maxAttempts})` : '';
          const desc = task.description.length > 50
            ? task.description.slice(0, 50) + '\u2026'
            : task.description;
          lines.push(`${taskIndent}${tIcon} ${agent}${desc}${attempts}`);
        }
      }

      // Latest progress message for active goals (like GoalBrowser's "… ask..." line)
      if (goal.status === 'active' && goal.latestMessage) {
        const msgIndent = '  '.repeat(depth + 1);
        const msg = goal.latestMessage.length > 60
          ? goal.latestMessage.slice(0, 60) + '\u2026'
          : goal.latestMessage;
        lines.push(`${msgIndent}\u2026 ${msg}`);
      }

      // Recurse into child goals.
      for (const [childId, child] of this.liveGoals) {
        if (child.parentId === goalId) visit(childId, depth + 1);
      }
    };

    visit(this._currentGoalId, 0);
    return lines.join('\n');
  }

  private updateActivityHeader(header: string): void {
    this.activityHeader = header;
    this.scheduleActivityRefresh();
  }

  private updateActivityStep(step: number): void {
    this.activityStep = step;
    this.scheduleActivityRefresh();
  }

  /**
   * Trailing-debounced refresh — coalesces rapid-fire progress events into
   * a single label update / layout reflow cycle. Without this, a busy agent
   * run can fire 40+ updateLabel+updateLayoutChild round-trips per second
   * and starve the compositor, making the UI feel frozen.
   */
  private scheduleActivityRefresh(): void {
    if (this.activityRefreshTimer) return;
    this.activityRefreshTimer = setTimeout(() => {
      this.activityRefreshTimer = undefined;
      this.refreshActivityBubble().catch(() => { /* widget gone */ });
    }, 120);
  }

  private async refreshActivityBubble(): Promise<void> {
    if (!this.activityBubbleLabelId) return;
    const text = this.composeActivityText();
    const innerWidth = this.computeBubbleMaxWidth() - this.theme.tokens.space.xs * 2;
    const height = this.estimateBubbleHeight(text, innerWidth, false);
    // Keep the cached bubble text in sync so resize reflow uses the latest.
    const meta = this.messageMetadata.get(this.activityBubbleLabelId);
    if (meta) meta.text = text;
    await this.updateLabel(this.activityBubbleLabelId, text, this.theme.statusNeutral);
    // Only reflow layout when the height actually changed by at least one
    // line; avoids a pointless updateLayoutChild round-trip on text-only
    // updates.
    if (Math.abs(height - this.activityRefreshLastHeight) >= 17) {
      this.activityRefreshLastHeight = height;
      await this.setLabelHeight(this.activityBubbleLabelId, height);
    }
  }

  private async removeActivityBubble(): Promise<void> {
    if (this.activityRefreshTimer) {
      clearTimeout(this.activityRefreshTimer);
      this.activityRefreshTimer = undefined;
    }
    if (!this.activityBubbleLabelId) return;
    const id = this.activityBubbleLabelId;
    this.activityBubbleLabelId = undefined;
    this.activityStep = 0;
    this.activityRefreshLastHeight = 0;
    this.stepStreamChars = 0;
    this.liveGoals.clear();
    this.liveTasks.clear();
    await this.removeLabel(id);
  }

  private async setLabelHeight(labelId: AbjectId, height: number): Promise<void> {
    if (!this.messageLogId) return;
    try {
      await this.request(request(this.id, this.messageLogId, 'updateLayoutChild', {
        widgetId: labelId,
        preferredSize: { height },
      }));
    } catch { /* layout may be gone */ }
  }

  // ── Resize reflow ────────────────────────────────────────────────────

  /** Debounce resize-driven reflow so rapid drag events collapse into one pass. */
  private scheduleReflow(): void {
    if (this.reflowTimer) return;
    this.reflowTimer = setTimeout(() => {
      this.reflowTimer = undefined;
      this.reflowAllBubbles().catch(() => { /* window may be gone */ });
    }, 140);
  }

  /**
   * Recompute width+height for every bubble and paired sender header against
   * the current window width. Also re-render the welcome state so its card
   * and chips fit the new size. All updates are issued concurrently.
   */
  private async reflowAllBubbles(): Promise<void> {
    if (!this.messageLogId || !this.windowId) return;

    const bubbleMaxWidth = this.computeBubbleMaxWidth();
    const innerWidth = bubbleMaxWidth - this.theme.tokens.space.xs * 2;
    const updates: Promise<unknown>[] = [];

    for (const labelId of this.messageLabelIds) {
      const meta = this.messageMetadata.get(labelId);
      if (!meta) continue;

      const height = this.estimateBubbleHeight(meta.text, innerWidth, meta.markdown);
      updates.push(
        this.request(request(this.id, this.messageLogId, 'updateLayoutChild', {
          widgetId: labelId,
          sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
          preferredSize: { width: bubbleMaxWidth, height },
          alignment: meta.align,
        })).catch(() => { /* widget gone */ })
      );

      // If this bubble has a paired sender header, update its width too.
      const senderId = this.bubbleSenderLabels.get(labelId);
      if (senderId) {
        updates.push(
          this.request(request(this.id, this.messageLogId, 'updateLayoutChild', {
            widgetId: senderId,
            sizePolicy: { vertical: 'fixed', horizontal: meta.align === 'center' ? 'expanding' : 'fixed' },
            preferredSize: {
              height: SENDER_LABEL_HEIGHT,
              width: meta.align === 'center' ? undefined : bubbleMaxWidth,
            },
            alignment: meta.align,
          })).catch(() => { /* widget gone */ })
        );
      }
    }

    await Promise.all(updates);

    // The welcome state is rendered with hand-built widths outside the
    // bubble path; re-render it from scratch so it fits the new window size.
    if (this.welcomeWidgetIds.length > 0) {
      await this.removeWelcomeState();
      await this.showWelcomeState();
    }

    // Keep activity bubble's cached height estimate aligned to avoid a
    // spurious extra layout write on the next progress tick.
    if (this.activityBubbleLabelId) {
      const meta = this.messageMetadata.get(this.activityBubbleLabelId);
      if (meta) {
        this.activityRefreshLastHeight = this.estimateBubbleHeight(meta.text, innerWidth, false);
      }
    }
  }


  private async updateLabel(labelId: AbjectId, text: string, color: string): Promise<void> {
    if (!labelId) return;
    try {
      await this.request(
        request(this.id, labelId, 'update', {
          text,
          style: { color, fontSize: 13, wordWrap: true },
        })
      );
    } catch { /* label may be gone */ }
  }

  private async removeLabel(labelId: AbjectId): Promise<void> {
    if (!labelId || !this.messageLogId) return;

    // If this bubble has a paired sender header, remove it too so we don't
    // leave orphaned "Agent · now" lines floating in the log.
    const pairedSenderId = this.bubbleSenderLabels.get(labelId);
    if (pairedSenderId) {
      this.bubbleSenderLabels.delete(labelId);
      await this.detachLabel(pairedSenderId);
    }

    await this.detachLabel(labelId);
  }

  /** Low-level: remove a single label id from layout + destroy + tracking. */
  private async detachLabel(labelId: AbjectId): Promise<void> {
    if (!labelId || !this.messageLogId) return;
    try {
      await this.request(request(this.id, this.messageLogId, 'removeLayoutChild', {
        widgetId: labelId,
      }));
    } catch { /* may already be gone */ }
    try {
      await this.request(request(this.id, labelId, 'destroy', {}));
    } catch { /* already gone */ }

    const idx = this.messageLabelIds.indexOf(labelId);
    if (idx >= 0) this.messageLabelIds.splice(idx, 1);
    this.messageMetadata.delete(labelId);
  }

  private async clearMessageLabels(): Promise<void> {
    if (!this.messageLogId) return;

    // Clear layout in one request
    try {
      await this.request(request(this.id, this.messageLogId, 'clearLayoutChildren', {}));
    } catch { /* may already be gone */ }

    // Fire-and-forget destroy all labels
    for (const labelId of this.messageLabelIds) {
      this.send(request(this.id, labelId, 'destroy', {}));
    }
    this.messageLabelIds = [];
    this.messageMetadata.clear();
    this.bubbleSenderLabels.clear();
    this.activityBubbleLabelId = undefined;
    this.activityStep = 0;
    this.liveGoals.clear();
    this.liveTasks.clear();
    // Welcome widgets (chips + card) live inside the message log and were
    // just cleared above; drop our tracked ids.
    this.welcomeWidgetIds = [];
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Chat Usage Guide

### Choosing between sendMessage and addNotification

Two ways to place text into the chat, with very different behavior:

- \`sendMessage\` behaves exactly as though the user typed the text in the input box and pressed Enter. Use it for any human-authored input, including messages bridged in from an external channel (bridges, proxies, relays, integrations). Pass the text through verbatim so the agent sees the user's exact words.
- \`addNotification\` displays a labeled bubble and stops there: no agent loop runs. Use it for machine-authored status, alerts, briefings, scheduler output, or results from other objects.

The fast rule: if the text is a person speaking to the chat, use \`sendMessage\`; if the text is an object reporting a result, use \`addNotification\`.

### Send a message programmatically (equivalent to typing and pressing Enter)

  await call(await dep('Chat'), 'sendMessage', { message: 'Hello, what can you do?' });
  // Chat treats the text as user input and runs the full observe-think-act loop.

Relaying a user's message from another channel (bridge / proxy pattern):

  // A user message arrived on another channel (SMS, email, another messaging service).
  // Forward it verbatim so the agent reacts the same as if they had typed it locally.
  await call(await dep('Chat'), 'sendMessage', { message: incomingText });
  // The chat log renders this as user input; the agent processes the exact words received.

### Show / hide the Chat window

  await call(await dep('Chat'), 'show', {});
  await call(await dep('Chat'), 'hide', {});

### Get current state

  const state = await call(await dep('Chat'), 'getState', {});
  // state: { phase, messageCount, visible, currentGoalId }

### Display a notification (for machine-authored output; no agent loop runs)

  await call(await dep('Chat'), 'addNotification', {
    sender: 'WeatherScheduler',
    message: 'Daily briefing: 62F, partly cloudy in Silverdale WA.'
  });
  // Renders a labeled bubble from the given sender. Supports markdown.
  // Use this when an object, scheduler, watcher, or agent produces a result and you want
  // to surface it in the chat log. For a user's message arriving from another channel,
  // use sendMessage instead so the agent actually processes the input.

### Clear conversation history

  await call(await dep('Chat'), 'clearHistory', {});

### Observe messages as they land (bridge / proxy / relay pattern)

Chat emits a \`messageAdded\` event every time a durable bubble is appended to the log. This is the hook for forwarding Chat traffic to an external channel (Telegram, SMS, email, another messaging service). Subscribe via \`addDependent\` and you receive every user message, every assistant reply, every system notification, and every error.

  // In your bridge / proxy / relay object's startup handler:
  await call(await dep('Chat'), 'addDependent', {});

  // Then implement the changed-event handler:
  async messageAdded(msg) {
    const { role, sender, text, markdown, at } = msg.payload;
    // role is one of: 'user' | 'assistant' | 'system' | 'error'
    // The transient 'activity' role (in-progress agent status) is already filtered out.
    // Forward to your external channel here.
    await this._sendToExternalChannel(text);
  }

Role meanings:
- **user**: something the local user typed, or was injected via \`sendMessage\` from a bridge.
- **assistant**: the agent's reply rendered via \`done\`.
- **system**: a labeled notification added via \`addNotification\` (machine-authored output).
- **error**: an error bubble surfaced in the log.

A full bidirectional bridge combines two sides: subscribe to \`messageAdded\` for outbound forwarding, and call \`Chat.sendMessage\` to inject inbound messages as user input. Use the \`role\` field to avoid echo loops: when relaying an inbound external message via \`sendMessage\`, the resulting \`messageAdded\` event carries \`role: 'user'\` on the next turn; tag your own forwards (e.g. with a per-source Set of recent text hashes) to skip re-forwarding.

### Goal Tracking

Chat creates a Goal (via GoalManager) for each user message it processes.
Query the current goal to observe Chat's progress:

  const state = await call(await dep('Chat'), 'getState', {});
  if (state.currentGoalId) {
    const goal = await call(await dep('GoalManager'), 'getGoal', { goalId: state.currentGoalId });
    // goal.progress has step-by-step updates
  }

Subscribe to GoalManager's changed events (goalUpdated, goalCompleted, goalFailed) for real-time updates.

### IMPORTANT
- The interface ID is 'abjects:chat'.
- Chat is an agent: it uses AgentAbject's observe-think-act loop to process messages.
- sendMessage is the programmatic equivalent of typing into the input box and pressing Enter. It triggers the full agent cycle: the LLM decides what actions to take. Pass user text through verbatim.
- addNotification places a bubble in the chat log and stops; it is for machine-authored output, and the agent does not react to it.
- Actions can include creating objects, calling other services, or replying with text.
- getState returns currentGoalId when Chat is actively processing a message (null otherwise).
- Chat can receive tasks via LLM semantic fallback even for task types it doesn't explicitly declare.`;
  }
}

export const CHAT_ID = 'abjects:chat' as AbjectId;
