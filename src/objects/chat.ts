/**
 * Chat — a conversation with the system, as data and behaviour.
 *
 * Registers with AgentAbject as an agent: AgentAbject drives the
 * think-act-observe loop and calls back here to observe and act. Chat routes
 * what the person asks into goals, follows those goals through GoalManager,
 * and keeps the transcript.
 *
 * It draws nothing. Everything a person sees of it goes out as events: every
 * message as `messageAdded` (the terminal gateway, bridges and the chat window
 * all listen), the title, whether it is working, and (to its window only) the
 * live activity and composer state. On a desktop `show` spawns a ChatWindow, a
 * separate view abject, and `hide` closes it; with no display, `show` reports
 * false and the conversation carries on exactly the same.
 */

import { AbjectId, AbjectMessage, InterfaceId, SpawnResult } from '../core/types.js';
import { v4 as uuidv4 } from 'uuid';
import { captureConversation, identifyMessages, type ConversationContext } from '../core/conversation-context.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { looksLikeAbsenceClaim, looksLikeClaim } from '../core/claims.js';
import { replyKindQuestions, REPLY_KINDS_TO_AUDIT, criterion, instruction } from '../core/decision-questions.js';
import { choiceOf, type DecisionOutcome, type DecisionQuestion } from '../llm/decision.js';
import { request, event } from '../core/message.js';
import { require as precondition, invariant } from '../core/contracts.js';
import type { AgentAction } from './agent-abject.js';
import type { ContentPart } from '../llm/provider.js';
import { Log } from '../core/timed-log.js';

const log = new Log('Chat');
const CHAT_INTERFACE: InterfaceId = 'abjects:chat';

/**
 * Think tier for every Chat step, including step 0 (which skips observation,
 * so it carries the tier through firstThinkTier instead of the observe hint).
 */
const CHAT_THINK_TIER = 'balanced';

/**
 * How a user message should be handled (site chat.route). Chat itself can
 * only converse; anything that acts or looks at live state becomes a goal.
 * One choice decides: a goal is created directly only for
 * `goal_self_contained`, so "needs a goal" and "can be acted on alone" are a
 * single answer rather than two combined in code.
 */
const CHAT_ROUTE_QUESTIONS: Record<string, DecisionQuestion> = {
  route: {
    type: 'choice',
    instructions: instruction('Pick the handling for `message`, using `recent` for context. The assistant can only converse; it acts and observes by creating goals that agents carry out.', {
      focus: 'Whether the message asks for something done, fetched, shown, changed, checked, or investigated (a goal), and whether it can be acted on without the earlier conversation.',
    }),
    criteria: {
      goal_self_contained: criterion('Asks for an action, data, or an investigation, and says everything needed to act on it.', {
        notFor: 'A request that leans on earlier messages to say what it means.',
        examples: ["What's the weather in Seattle?", 'Find the oldest note in my wiki.'],
      }),
      goal_needs_context: criterion('Asks for an action or data, but refers back to the conversation to say what (it, that, those, the second one, yes do it).', {
        examples: ['ok, delete the safe ones', 'do the second one'],
      }),
      converse: criterion('A greeting, thanks, small talk, or a question answerable from facts already in the conversation or recent goal results.', {
        notFor: 'Questions about live state or this system\'s objects, which need a goal.',
        examples: ['thanks!', 'is my understanding of the summary right?'],
      }),
      remember: criterion('Shares a standing personal fact or preference worth saving.', {
        examples: ['I live in Portland.'],
      }),
      clarify: criterion('Ambiguous in a way only the user can settle: which of their things, the desired outcome, or an irreversible choice.'),
    },
  },
};

const ROUTE_HINTS: Record<string, string> = {
  goal_self_contained: 'a request that needs a goal',
  goal_needs_context: 'a request that needs a goal, using the earlier conversation to resolve its references',
  converse: 'conversation you can answer directly',
  remember: 'a personal fact worth remembering',
  clarify: 'ambiguous in a way only the user can settle',
};

type ChatTurn = { success: boolean; result?: unknown; error?: string; maxStepsReached?: boolean; goalCreated: boolean };

/**
 * The desktop-only part of the routing prompt: windows, the 3D scene and
 * decorating them exist only where there is a display.
 */
const DESKTOP_SCENE_PROMPT = `## The desktop is a 3D scene

The desktop is a native 3D scene: every window is a slab in it, and objects can attach real 3D content (meshes, lights, transforms) through their window in addition to drawing 2D content on canvases. 3D objects can also live free-floating in the global scene with no window at all — the right shape when the user asks for a standalone object on the desktop (a pet, a draggable shape, ambient décor) rather than an app UI. Word goals to match: a standalone object should float on the desktop itself, not live in a window. Existing windows — including built-in apps' windows — can be DECORATED by a separate object that finds the window and attaches 3D content to it, so "add X to the Y window" goals should say to decorate the existing window, keeping the original app untouched (never to rebuild or clone the app). When a request involves visuals, describe the desired OUTCOME in the goal and let the builders discover the current rendering capabilities live (they ask the UI objects for up-to-date vocabularies) — do not prescribe rendering implementation details (like "use 2D canvas with projection math") from memory; such recalled how-tos may predate current capabilities.

`;

// ── Attachments ────────────────────────────────────────────────────────
/** Image MIME types the LLM vision content part accepts. */
const IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** Max characters of a text/code attachment injected into the prompt. */
const MAX_ATTACHMENT_CHARS = 40_000;
const ATTACH_GLYPH = '📎';

// ── Conversation ───────────────────────────────────────────────────────
const MAX_CONVERSATION_ENTRIES = 40;
const MAX_STEPS = 20;
/** Leading mark on the activity header (the kit's sigil ring). */
const THINKING_TEXT = '◉ Thinking…';

/** How long the answer to "does this instance have a display" is trusted. */
const DISPLAY_CHECK_TTL_MS = 60_000;

/** Who a message is from, as the transcript and its listeners see it. */
export type ChatRole = 'user' | 'assistant' | 'system' | 'error' | 'activity';

/** A pasted image the person sent along with a message. */
export interface ChatImage { name: string; mimeType: string; base64: string }

/**
 * What the composer can do right now, for the window. A goal in progress turns
 * the send button into pause/resume and adds stop; a clarification question
 * waits for the next message as its answer.
 */
export interface ChatControls {
  /** A routing turn is running and no goal has taken over yet. */
  turnBusy: boolean;
  /** A goal this conversation owns is running or paused. */
  goalActive: boolean;
  paused: boolean;
  clarifying: boolean;
}

/** One goal in the live progress tree, for the window's activity view. */
export interface ChatActivityGoal {
  id: string;
  parentId?: string;
  title: string;
  description?: string;
  status: 'active' | 'completed' | 'failed';
  latestMessage?: string;
  latestAgent?: string;
}

export interface ChatActivityTask {
  id: string;
  description: string;
  status: string;
  agentName?: string;
  claimedBy?: string;
  attempts: number;
  maxAttempts: number;
  dependsOn?: string[];
}

/** The live "thinking / goal progress" state the window shows under the log. */
export interface ChatActivity {
  active: boolean;
  header: string;
  rootId?: string;
  goals: ChatActivityGoal[];
  tasks: Record<string, ChatActivityTask[]>;
}

/** A transcript entry as listeners render it. */
export interface ChatMessageView {
  id: string;
  role: ChatRole;
  sender: string;
  text: string;
  markdown: boolean;
  at: number;
}

// ─── Chat-specific types ─────────────────────────────────────────────

interface ConversationEntry {
  id?: string;
  sourceGoalId?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /**
   * Display-only entry. Persisted so a reopened window replays it, but
   * skipped when assembling the LLM context: the markdown typically carries a
   * data URI (image, screenshot) whose raw bytes would balloon every
   * subsequent LLM call with no benefit. Set true on `attachMedia`.
   */
  media?: boolean;
  /** Display-name override; otherwise "You" / "Agent" / "System" by role. */
  sender?: string;
  /**
   * An uploaded file stored in the workspace FileSystem. Unlike `media`,
   * attachments ARE included in the LLM context: once with full content (on
   * the turn after upload), then as a short text reference on later turns to
   * keep token cost bounded. `injected` flips true after the full content has
   * been sent once.
   */
  attachment?: {
    path: string;
    name: string;
    mimeType: string;
    kind: 'text' | 'image' | 'document';
    injected?: boolean;
  };
}

type TurnPhase = 'idle' | 'busy';

interface ChatConstructorArgs {
  conversationId?: string;
  title?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export class Chat extends Abject {
  private registryId?: AbjectId;
  private agentAbjectId?: AbjectId;
  private storageId?: AbjectId;
  private chatManagerId?: AbjectId;
  private fileSystemId?: AbjectId;
  private factoryId?: AbjectId;
  private instanceInfoId?: AbjectId;

  // Conversation identity (passed via constructor args; unset for legacy callers)
  private conversationId?: string;
  private conversationTitle?: string;
  /** Where the window opens; the window reports moves back here. */
  private initialRect?: { x: number; y: number; width: number; height: number };
  private rectPersistTimer?: ReturnType<typeof setTimeout>;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private historyLoaded = false;

  /** The ChatWindow drawing this conversation, while one is open. */
  private windowId?: AbjectId;
  /** Whether this instance has a display, and when that was last asked. */
  private displayCheck?: { at: number; display: boolean };

  private turnPhase: TurnPhase = 'idle';
  private goalPaused = false;
  /** Goal the user asked to stop: its failure is their doing, not an error. */
  private stopRequestedGoalId?: string;
  /**
   * The scrum master paused the goal to ask the user a question (ask_user).
   * The next message answers it and auto-resumes the goal, unlike a
   * user-initiated pause, which resumes only when asked to.
   */
  private clarificationPending = false;

  private conversationHistory: ConversationEntry[] = [];
  private turnContext?: ConversationContext;
  /** Last goalActivity value emitted (dedupe transitions). */
  private lastGoalActivity?: boolean;

  // ── Live activity (the window's "thinking / goal progress" view) ──
  private activityActive = false;
  private activityStep = 0;
  private activityHeader = THINKING_TEXT;
  private activityRefreshTimer?: ReturnType<typeof setTimeout>;
  /** Streamed character count for the current LLM step. Reset each phase. */
  private stepStreamChars = 0;

  /**
   * Live snapshot of goals being worked on for the current task, fed by
   * GoalManager's goalCreated/goalUpdated/goalCompleted/goalFailed events.
   */
  private liveGoals = new Map<string, {
    title: string;
    description?: string;
    status: 'active' | 'completed' | 'failed';
    parentId?: string;
    latestMessage?: string;
    latestAgent?: string;
    /** Final synthesized result (set on goalCompleted) / error (on goalFailed).
     * Surfaced through agentObserve so a step that timed out still sees the
     * outcome once it lands, instead of re-planning duplicate goals. */
    result?: unknown;
    error?: string;
  }>();

  /**
   * Rolling record of finished goals (newest last, capped). Fed into the
   * planning prompt and observations so the LLM knows what has already been
   * accomplished this session and does not re-create equivalent goals after
   * a transient wait failure.
   */
  private recentGoalOutcomes: Array<{
    goalId: string;
    title: string;
    status: 'completed' | 'failed';
    finishedAt: number;
    resultPreview?: string;
  }> = [];

  /** Task info per goal, fetched from GoalManager. */
  private liveTasks = new Map<string, ChatActivityTask[]>();

  /** Pending routing-task replies, with scoped inactivity timeouts. */
  private pendingTickets = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; timeoutMs: number }>();

  /** Current active ticket ID (for progress/stream routing). */
  private _currentTicketId?: string;

  /** Accumulated streaming buffer for current task. */
  private _streamBuffer = '';

  /** GoalManager ID for cross-agent progress tracking. */
  private goalManagerId?: AbjectId;

  /** Current goal ID for the active task. */
  private _currentGoalId?: string;

  /**
   * Whether a goal was created during the current turn. A `done` that reports
   * an action or a verified outcome must be backed by a goal; if none ran this
   * turn, the reply is ungrounded (the model confabulated it). Reset at the
   * start of each turn, set true when the `goal` action creates one, and read
   * after the task to decide whether to run the self-audit re-prompt.
   */
  private _goalCreatedThisTurn = false;

  /**
   * Whether this conversation is currently subscribed to GoalManager's events.
   * With lazy rehydration each conversation is its own Chat instance, so an
   * idle chat must NOT subscribe: otherwise one running goal's progress events
   * fan out to every open conversation and flood the bus. We subscribe only
   * while a goal we created is active, and stay subscribed for the instance's
   * life so a late outcome (after the task returned) still lands here.
   */
  private _goalSubscribed = false;

  /** Pending task completion promises: taskId → resolve/reject. */
  private pendingTaskCompletions = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; timeoutMs: number }>();


  constructor(args?: ChatConstructorArgs) {
    super({
      manifest: {
        name: 'Chat',
        description:
          'A conversation with the system. Chat naturally to explore, create, and control Abjects; requests become goals the agents carry out. Uses a think-act-observe loop with structured actions.',
        version: '1.0.0',
        interface: {
            id: CHAT_INTERFACE,
            name: 'Chat',
            description: 'A conversational LLM agent',
            methods: [
              {
                name: 'show',
                description: 'Open the conversation in a window on the desktop. Returns false when this instance has no display.',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'hide',
                description: 'Close the conversation window (the conversation itself goes on).',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'sendMessage',
                description: 'Send a message to the chat agent, as though the user typed it. While a goal runs, the message goes to that goal as a note.',
                parameters: [
                  { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'The message text' },
                  { name: 'images', type: { kind: 'array', elementType: { kind: 'object', properties: {} } }, description: 'Pasted images: [{ name, mimeType, base64 }]', optional: true },
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
                name: 'getTranscript',
                description: 'The conversation so far as rendered messages, with the title, composer state and live activity: what a view needs to draw it.',
                parameters: [],
                returns: { kind: 'object', properties: {} },
              },
              {
                name: 'pauseGoal',
                description: 'Pause the goal this conversation is running.',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'resumeGoal',
                description: 'Resume the paused goal.',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'stopGoal',
                description: 'Stop the goal entirely.',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'addNotification',
                description: 'Display a message in the chat without triggering the agent loop. Use this for notifications, status updates, or results from other agents.',
                parameters: [
                  { name: 'sender', type: { kind: 'primitive', primitive: 'string' }, description: 'Display name of the sender (e.g. agent name)' },
                  { name: 'message', type: { kind: 'primitive', primitive: 'string' }, description: 'The notification text (supports markdown)' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'attachMedia',
                description: 'Append an assistant message containing markdown media (typically an image data URI from a screenshot or render). Bypasses the LLM context so large data URIs never enter it; the LLM sees the agent\'s text summary instead. Use this from sub-task agents that captured user-facing media.',
                parameters: [
                  { name: 'markdown', type: { kind: 'primitive', primitive: 'string' }, description: 'Markdown content to render (e.g. ![alt|WxH](data:image/png;base64,...))' },
                  { name: 'sender', type: { kind: 'primitive', primitive: 'string' }, description: 'Optional display name; defaults to "Agent"' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'fileUploaded',
                description: 'Store a file in the workspace FileSystem and attach it to the conversation for the next turn.',
                parameters: [
                  { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'File name' },
                  { name: 'mimeType', type: { kind: 'primitive', primitive: 'string' }, description: 'MIME type' },
                  { name: 'base64', type: { kind: 'primitive', primitive: 'string' }, description: 'File bytes, base64' },
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
                description: 'Update the conversation title.',
                parameters: [
                  { name: 'title', type: { kind: 'primitive', primitive: 'string' }, description: 'New conversation title' },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
            events: [
              {
                name: 'messageAdded',
                description: 'Fires every time a message joins the conversation (user input, assistant reply, system notification, or error). Subscribe via addDependent to forward, mirror, or log messages from bridges, proxies, relays, and integrations. In-progress agent activity is not a message and never fires this. Includes conversationId for multi-chat subscribers and a message id.',
                payload: { kind: 'object', properties: {
                  conversationId: { kind: 'primitive', primitive: 'string' },
                  id: { kind: 'primitive', primitive: 'string' },
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
                name: 'goalActivity',
                description: 'Fires when this chat starts or stops working (a turn is running, or a goal this conversation owns is active and not yet terminal). ChatManager forwards it so surfaces can mark the chat busy.',
                payload: { kind: 'object', properties: {
                  active: { kind: 'primitive', primitive: 'boolean' },
                  goalId: { kind: 'primitive', primitive: 'string' },
                }},
              },
              {
                name: 'visibility',
                description: 'Fires when the conversation window opens (true) or closes (false).',
                payload: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
          },
        tags: ['system', 'agent'],
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
    this.registryId = await this.requireDep('Registry');
    this.agentAbjectId = await this.requireDep('AgentAbject');
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;
    this.storageId = await this.discoverDep('Storage') ?? undefined;
    this.chatManagerId = await this.discoverDep('ChatManager') ?? undefined;
    this.fileSystemId = await this.discoverDep('FileSystem') ?? undefined;

    // Do NOT subscribe to GoalManager unconditionally. An idle conversation
    // that watches every goal event is what floods the bus when many chats are
    // open (see _goalSubscribed). We reconnect only if this conversation left a
    // goal running before a restart; otherwise we stay quiet until we create a
    // goal ourselves (which subscribes then).
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
            this.conversationHistory = identifyMessages(this.conversationId, hist);
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

    await this.reconnectActiveGoal();

    // Register with AgentAbject (fire-and-forget: handler is idempotent)
    this.send(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'Chat',
      description: 'Conversational LLM agent for interacting with Abjects',
      canExecute: false,
      config: {
        pinnedMessageCount: 1,
        terminalActions: {
          goal: { type: 'success', execute: true },
          done: { type: 'success', resultFields: ['text', 'result', 'reasoning'] },
          clarify: { type: 'success', resultFields: ['question'], ownContentRequired: true },
          fail: { type: 'error', resultFields: ['reason'] },
        },
        intermediateActions: ['reply'],
        skipFirstObservation: true,
        firstThinkTier: CHAT_THINK_TIER,
      },
    }));
    this.checkInvariants();
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.turnPhase === 'idle' || this.turnPhase === 'busy', 'Chat: unknown turn phase');
    invariant(!this.clarificationPending || this._currentGoalId !== undefined,
      'Chat: a clarification is pending only while its goal is current');
  }

  protected override async onStop(): Promise<void> {
    // The window is a view of this conversation and has nothing to show once
    // it is gone. An event: a stopping object cannot wait for replies.
    if (this.windowId) {
      try { this.send(event(this.id, this.windowId, 'chatGone', {})); } catch { /* window gone */ }
      this.windowId = undefined;
    }
  }

  private setupHandlers(): void {
    this.on('show', async () => this.openWindow());

    this.on('hide', async () => this.closeWindow());

    // The window closed itself (its close button): forget it.
    this.on('windowClosed', async (msg: AbjectMessage) => {
      if (msg.routing.from !== this.windowId) return;
      await this.closeWindow();
    });

    // The window moved or resized: reopen it there, and keep the roster's copy.
    this.on('windowRect', (msg: AbjectMessage) => {
      if (msg.routing.from !== this.windowId) return;
      const { rect } = msg.payload as { rect?: { x: number; y: number; width: number; height: number } };
      if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(n => typeof n === 'number' && Number.isFinite(n))) return;
      this.initialRect = { ...rect };
      this.notifyRectChanged();
    });

    this.on('sendMessage', async (msg: AbjectMessage) => {
      const { message, images } = msg.payload as { message?: string; images?: ChatImage[] };
      const text = (message ?? '').trim();
      const pasted = Array.isArray(images) ? images.filter(i => i && typeof i.base64 === 'string' && i.base64.length > 0) : [];
      if (!text && pasted.length === 0) return false;
      // While a goal runs, a message (typed in the window, sent from the
      // terminal, a bridge) goes to that goal as a note the scrum master weighs.
      if (this._currentGoalId) {
        if (!text) return false;
        log.info(`[Chat] sendMessage → goal interjection: "${text.slice(0, 80)}"`);
        await this.sendInterjection(text);
        return true;
      }
      if (this.turnPhase !== 'idle') {
        log.info(`[Chat] sendMessage dropped (turn busy): "${text.slice(0, 80)}"`);
        return false;
      }
      log.info(`[Chat] sendMessage: "${text.slice(0, 80)}"`);
      if (pasted.length > 0) await this.commitImages(pasted);
      this.runChatTask(text);
      return true;
    });

    this.on('pauseGoal', async () => this.pauseGoal());
    this.on('resumeGoal', async () => this.resumeGoal());
    this.on('stopGoal', async () => this.stopGoal());

    this.on('attachMedia', async (msg: AbjectMessage) => {
      const { markdown, sender } = msg.payload as { markdown: string; sender?: string };
      if (!markdown?.trim()) return false;
      const trimmed = markdown.trim();
      const displaySender = sender || 'Agent';
      // Persist as a media-flagged entry. The flag keeps the data URI out of
      // every subsequent LLM call while still letting a reopened window replay
      // the image.
      const id = uuidv4();
      this.conversationHistory.push({ id, role: 'assistant', content: trimmed, media: true, sender: displaySender });
      this.appendMessage('assistant', displaySender, trimmed, true, id);
      this.schedulePersist();
      return true;
    });

    // A file picked or dropped onto the conversation (the window forwards it).
    // Store it in the workspace FileSystem and record an attachment entry for
    // the LLM context.
    this.on('fileUploaded', async (msg: AbjectMessage) => {
      const { name, mimeType, base64 } = msg.payload as { name: string; mimeType: string; base64: string };
      precondition(typeof name === 'string' && name.length > 0, 'fileUploaded needs a file name');
      await this.handleFileUploaded(name, mimeType ?? 'application/octet-stream', base64 ?? '');
      return true;
    });

    this.on('addNotification', async (msg: AbjectMessage) => {
      const { sender, message } = msg.payload as { sender: string; message: string };
      if (!message?.trim()) return false;
      log.info(`[Chat] addNotification from "${sender}": "${message.trim().slice(0, 80)}"`);
      const id = uuidv4();
      this.conversationHistory.push({ id, role: 'assistant', content: `[${sender}]: ${message.trim()}` });
      this.appendMessage('system', sender || 'System', message.trim(), true, id);
      this.schedulePersist();
      return true;
    });

    this.on('getState', async () => {
      return {
        phase: this.turnPhase,
        messageCount: this.conversationHistory.length,
        visible: !!this.windowId,
        currentGoalId: this._currentGoalId ?? null,
      };
    });

    this.on('getTranscript', async () => ({
      conversationId: this.conversationId ?? '',
      title: this.conversationTitle ?? '',
      messages: this.transcriptViews(),
      controls: this.controls(),
      activity: this.activitySnapshot(),
      working: this.isGoalActive(),
    }));

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
        try { this.send(event(this.id, this.windowId, 'chatCleared', {})); } catch { /* window gone */ }
      }
      return true;
    });

    this.on('setTitle', async (msg: AbjectMessage) => {
      const { title } = msg.payload as { title: string };
      const next = (title ?? '').trim().slice(0, 80);
      if (!next || next === this.conversationTitle) return false;
      this.conversationTitle = next;
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

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      // GoalManager events
      if (fromId !== this.goalManagerId) return;

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
      // Goal lifecycle events feed the live goal tree.
      if (!this._currentGoalId) return;

      if (aspect === 'goalClarificationRequested') {
        const data = value as { goalId: string; question: string };
        if (data.goalId === this._currentGoalId) {
          await this.handleClarificationRequested(data.question);
        }
        return;
      }

      if (aspect === 'goalCreated') {
        const data = value as { goalId: string; title: string; description?: string; parentId?: string };
        // Only track goals that are part of the current task's tree
        // (the current goal itself, or descendants of any goal we know).
        if (data.goalId === this._currentGoalId
            || (data.parentId && this.liveGoals.has(data.parentId))) {
          this.liveGoals.set(data.goalId, {
            title: data.title,
            description: data.description,
            status: 'active',
            parentId: data.parentId,
          });
          this.fetchGoalTasks(data.goalId).then(() => this.scheduleActivityRefresh());
          this.scheduleActivityRefresh();
        }
        return;
      }

      if (aspect === 'goalUpdated') {
        const data = value as { goalId: string; parentId?: string; message?: string; phase?: string; agentName?: string };
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
          this.fetchGoalTitle(data.goalId);
          this.fetchGoalTasks(data.goalId).then(() => this.scheduleActivityRefresh());
        }

        const entry = this.liveGoals.get(data.goalId);
        if (entry) {
          if (data.message) this.updateActivityHeader(data.message);
          if (data.message) entry.latestMessage = data.message;
          if (data.agentName && data.agentName !== 'Chat') entry.latestAgent = data.agentName;
          // Refetch tasks on any progress so we always show current state
          this.fetchGoalTasks(data.goalId).then(() => this.scheduleActivityRefresh());
          this.scheduleActivityRefresh();
        }
        return;
      }

      if (aspect === 'goalCompleted' || aspect === 'goalFailed') {
        const data = value as { goalId: string; result?: unknown; error?: string };
        await this.acceptGoalOutcome(data.goalId, aspect === 'goalCompleted' ? 'completed' : 'failed', data.result, data.error);
        return;
      }
    });

    // ── Ticket result/progress/stream handlers ──

    this.on('taskResult', async (msg: AbjectMessage) => {
      const payload = msg.payload as { ticketId: string };
      this.retainTaskResult(payload);
      const pending = this.pendingTickets.get(payload.ticketId);
      if (pending) {
        this.pendingTickets.delete(payload.ticketId);
        pending.resolve(payload);
      }
    });

    // ScrumMaster owns goal-level completion under the Scrum model: each
    // scrum reviews the prior round and decides whether to call completeGoal,
    // plan more tasks, or fail the goal. Chat watches `goalCompleted` /
    // `goalFailed` (broadcast via the changed handler) like any other observer.

    this.on('taskProgress', async (msg: AbjectMessage) => {
      // Reset pending ticket timeouts on agent progress
      this.resetPendingTicketTimeouts();
      const { ticketId, step, maxSteps, phase } =
        msg.payload as { ticketId: string; step: number; maxSteps: number; phase: string; action?: string };
      if (!this._currentTicketId) return;
      if (ticketId && ticketId !== this._currentTicketId) return;
      if (!this.activityActive) return;
      // Each new phase (thinking, observing, acting) is a fresh LLM call window.
      this.stepStreamChars = 0;
      if (phase === 'thinking') {
        this.updateActivityHeader(`${THINKING_TEXT} (step ${step + 1}/${maxSteps})`);
      } else if (phase === 'observing') {
        this.updateActivityHeader(`◎ Observing… (step ${step + 1}/${maxSteps})`);
      }
    });

    this.on('taskStream', async (msg: AbjectMessage) => {
      const { ticketId, content } =
        msg.payload as { ticketId: string; content: string; done: boolean };
      if (!this._currentTicketId) return;
      if (ticketId && ticketId !== this._currentTicketId) return;
      // The raw text is mid-step reasoning and JSON actions, so it is not
      // shown; its volume is, so the person can see the model is working.
      this._streamBuffer += content;
      this.stepStreamChars += content.length;
      this.scheduleActivityRefresh();
    });

    this.on('progress', async (msg: AbjectMessage) => {
      // Reset pending ticket + task completion timeouts on any progress signal.
      // The progress text itself is surfaced through the live goal tree (via
      // goalUpdated events), so nothing to render here directly.
      this.resetPendingTicketTimeouts();
      const { message } = msg.payload as { phase?: string; message?: string };
      if (!this._currentTicketId || !message) return;
    });

    // ── AgentAbject callback handlers ──

    this.on('agentObserve', async (_msg: AbjectMessage) => {
      // Surface live goal state to the planning LLM. This matters most after
      // a goal action "failed" from a transient wait timeout: the goal keeps
      // running (or completes) in the background, and without this the LLM
      // only ever sees the stale failure and re-creates duplicate goals.
      //
      // Chat's work is routing (create a goal vs answer) and composing the
      // reply from a goal's result: balanced-tier work, on the interactive
      // path the user waits on. The self-audit re-prompt (runChatTask) is the
      // net for the confabulation a lighter model could invite.
      return { observation: this.buildGoalStateObservation(), tier: CHAT_THINK_TIER };
    });

    this.on('agentAct', (msg: AbjectMessage) => {
      const { action, taskId } = msg.payload as { taskId: string; step: number; action: AgentAction };
      this.handleAgentAct(action, { id: msg.routing.from, taskId }).then(
        (result) => this.sendDeferredReply(msg, result),
        (err) => this.sendDeferredReply(msg, {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      return DEFERRED_REPLY;
    });

    this.on('agentPhaseChanged', async (msg: AbjectMessage) => {
      const { step, newPhase } =
        msg.payload as { taskId: string; step: number; oldPhase: string; newPhase: string; action?: string };
      if (!this.activityActive) return;
      if (newPhase === 'thinking') {
        this.updateActivityStep(step + 1);
      }
      // 'acting' transitions surface through the live goal tree once the
      // action's goal lifecycle events fire.
    });

    this.on('agentIntermediateAction', async (msg: AbjectMessage) => {
      const { action } = msg.payload as { taskId: string; action: AgentAction };
      // 'reply': intermediate text from the agent, shown as an assistant
      // message while the activity view stays up for the next step.
      if (action.action === 'reply') {
        const text = (action.text as string) ?? '';
        if (text) {
          this._streamBuffer = '';
          const id = uuidv4();
          this.conversationHistory.push({ id, role: 'assistant', content: text });
          this.appendMessage('assistant', 'Agent', text, true, id);
          this.schedulePersist();
          this.stepStreamChars = 0;
          this.scheduleActivityRefresh();
        }
      }
    });

    this.on('agentActionResult', async (msg: AbjectMessage) => {
      // Goal-shaped actions surface their success/failure through
      // goalCompleted / goalFailed events into the live goal tree. Non-goal
      // actions (remember, reply, done) are reflected in the history directly.
      //
      // One case deserves a visible note: the goal action's wait failed
      // (usually a stall-timer timeout) while the goal itself is still
      // running. Silently re-planning here is how duplicate goals happen, and
      // the user has no way to see it, so say it in the thread.
      const { action, result } = msg.payload as {
        action?: { action?: string; title?: string };
        result?: { success?: boolean; error?: string };
      };
      if (action?.action !== 'goal' || result?.success !== false) return;
      const goalId = this._currentGoalId;
      const entry = goalId ? this.liveGoals.get(goalId) : undefined;
      if (!entry || entry.status !== 'active') return;
      const note = `Lost contact with goal "${entry.title}" (${result.error ?? 'wait failed'}), its last recorded status is active. Progress is unconfirmed; this chat will receive further goal events.`;
      this.appendMessage('system', 'Chat', note, false);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // The window (a separate view abject, desktop only)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Open the conversation in a ChatWindow, or raise the one already open. The
   * Factory has no ChatWindow on an instance without a display, so the spawn
   * fails and this reports false: the conversation is unaffected.
   */
  private async openWindow(): Promise<boolean> {
    if (this.windowId) {
      try {
        await this.request(request(this.id, this.windowId, 'raise', {}), 5000);
        return true;
      } catch {
        this.windowId = undefined; // gone; open a fresh one
      }
    }
    this.factoryId = await this.resolveDep('Factory', this.factoryId);
    if (!this.factoryId) return false;
    let windowId: AbjectId;
    try {
      const spawned = await this.request<SpawnResult>(request(this.id, this.factoryId, 'spawn', {
        manifest: { name: 'ChatWindow', description: '', version: '1.0.0', tags: ['system', 'ui'] },
        registryHint: (await this.resolveRegistryId()) ?? undefined,
        parentId: this.id,
        constructorArgs: {
          chatId: this.id,
          conversationId: this.conversationId,
          title: this.conversationTitle,
          rect: this.initialRect,
        },
      }), 20000);
      windowId = spawned.objectId;
    } catch (err) {
      log.info(`[Chat ${(this.conversationId ?? this.id).slice(0, 8)}] no window: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
    this.windowId = windowId;
    await this.placeWindowInWorkspace(windowId);
    try {
      await this.request(request(this.id, windowId, 'show', {}), 20000);
    } catch (err) {
      log.warn(`[Chat] the chat window could not open: ${err instanceof Error ? err.message : String(err)}`);
      await this.killWindow(windowId);
      this.windowId = undefined;
      return false;
    }
    this.changed('visibility', true);
    return true;
  }

  /**
   * The desktop shows a window with the workspace of the object that owns
   * it. The window is ours, in our workspace: say so before it draws, so it
   * appears there and wears that workspace's theme. Only the desktop keeps
   * that map, and only a desktop ever spawns a window.
   */
  private async placeWindowInWorkspace(windowId: AbjectId): Promise<void> {
    const registryId = await this.resolveRegistryId();
    const widgetManagerId = await this.discoverDep('WidgetManager');
    if (!registryId || !widgetManagerId) return;
    try {
      const workspaceId = await this.request<string | null>(request(this.id, registryId, 'getWorkspaceId', {}), 5000);
      if (workspaceId) {
        await this.request(request(this.id, widgetManagerId, 'setObjectWorkspace', { objectId: windowId, workspaceId }), 5000);
      }
    } catch { /* drawn untagged: visible on every workspace */ }
  }

  private async closeWindow(): Promise<boolean> {
    const windowId = this.windowId;
    if (!windowId) return true;
    this.windowId = undefined;
    // Flush any pending history persist before the view goes away.
    if (this.persistTimer) {
      this.cancelTimer(this.persistTimer);
      this.persistTimer = undefined;
      void this.persistHistory();
    }
    try { await this.request(request(this.id, windowId, 'close', {}), 5000); } catch { /* already closed */ }
    await this.killWindow(windowId);
    this.changed('visibility', false);
    return true;
  }

  private async killWindow(windowId: AbjectId): Promise<void> {
    if (!this.factoryId) return;
    try { await this.request(request(this.id, this.factoryId, 'kill', { objectId: windowId }), 5000); } catch { /* already gone */ }
  }

  /** A one-shot effect on the window (visual only; nothing without one). */
  private playEffect(effect: string, color?: string): void {
    if (!this.windowId) return;
    try { this.send(event(this.id, this.windowId, 'chatEffect', { effect, ...(color ? { color } : {}) })); } catch { /* window gone */ }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Messages, activity and controls: what listeners see
  // ═══════════════════════════════════════════════════════════════════

  /**
   * A message joins the conversation: announce it to every listener (the
   * terminal gateway, bridges, the window). Persisting it is the caller's
   * business; some messages (errors, notes) are shown but never saved.
   */
  private appendMessage(role: Exclude<ChatRole, 'activity'>, sender: string, text: string, markdown: boolean, id: string = uuidv4()): void {
    precondition(typeof text === 'string', 'message text must be a string');
    this.changed('messageAdded', {
      conversationId: this.conversationId ?? '',
      id,
      role,
      sender,
      text,
      markdown,
      at: Date.now(),
    });
  }

  /** The saved conversation as listeners render it. */
  private transcriptViews(): ChatMessageView[] {
    return this.conversationHistory.map((entry) => {
      const role: ChatRole = entry.role === 'user' ? 'user' : entry.role === 'assistant' ? 'assistant' : 'system';
      const defaultSender = entry.role === 'user' ? 'You' : entry.role === 'assistant' ? 'Agent' : 'System';
      return {
        id: entry.id ?? uuidv4(),
        role,
        sender: entry.sender ?? defaultSender,
        text: entry.content,
        // Attachment chips use markdown (bold filename) even though they're user-role.
        markdown: entry.role !== 'user' || !!entry.attachment,
        at: 0,
      };
    });
  }

  private controls(): ChatControls {
    return {
      turnBusy: this.turnPhase === 'busy',
      goalActive: this._currentGoalId !== undefined,
      paused: this.goalPaused,
      clarifying: this.clarificationPending,
    };
  }

  /** Tell the window what the composer can do now. */
  private pushControls(): void {
    if (!this.windowId) return;
    try { this.send(event(this.id, this.windowId, 'chatControls', this.controls())); } catch { /* window gone */ }
  }

  private activitySnapshot(): ChatActivity {
    const goals: ChatActivityGoal[] = [];
    for (const [id, g] of this.liveGoals) {
      goals.push({
        id, parentId: g.parentId, title: g.title, description: g.description,
        status: g.status, latestMessage: g.latestMessage, latestAgent: g.latestAgent,
      });
    }
    const tasks: Record<string, ChatActivityTask[]> = {};
    for (const [goalId, list] of this.liveTasks) tasks[goalId] = list;
    return { active: this.activityActive, header: this.composeActivityText(), rootId: this._currentGoalId, goals, tasks };
  }

  /** Tell the window the live activity state now. */
  private pushActivity(): void {
    if (!this.windowId) return;
    try { this.send(event(this.id, this.windowId, 'chatActivity', this.activitySnapshot())); } catch { /* window gone */ }
  }

  private showActivity(): void {
    if (this.activityActive) return;
    this.activityActive = true;
    this.activityStep = 0;
    this.activityHeader = THINKING_TEXT;
    this.stepStreamChars = 0;
    if (!this._currentGoalId) { this.liveGoals.clear(); this.liveTasks.clear(); }
    this.pushActivity();
  }

  private removeActivity(): void {
    if (this.activityRefreshTimer) {
      this.cancelTimer(this.activityRefreshTimer);
      this.activityRefreshTimer = undefined;
    }
    if (!this.activityActive) return;
    this.activityActive = false;
    this.activityStep = 0;
    this.stepStreamChars = 0;
    this.liveGoals.clear();
    this.liveTasks.clear();
    this.pushActivity();
  }

  private composeActivityText(): string {
    const baseHeader = this.activityStep > 0
      ? `${THINKING_TEXT} (step ${this.activityStep}/${MAX_STEPS})`
      : this.activityHeader;
    // A streaming hint so the person sees the model is producing output even
    // when no other progress signal has fired yet (~4 chars/token).
    return this.stepStreamChars > 0
      ? `${baseHeader}  ·  ~${Math.max(1, Math.round(this.stepStreamChars / 4))} tok streamed`
      : baseHeader;
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
   * Trailing-debounced push: coalesces rapid-fire progress events into one
   * snapshot. A busy agent run fires dozens of progress events per second.
   */
  private scheduleActivityRefresh(): void {
    if (this.activityRefreshTimer || !this.windowId) return;
    this.activityRefreshTimer = this.setTimer(() => {
      this.activityRefreshTimer = undefined;
      this.pushActivity();
    }, 120);
  }

  /**
   * Emit the goalActivity aspect on busy-state transitions. Busy means either
   * a turn is running or this conversation owns an active goal (created but
   * not yet accepted as terminal).
   */
  private emitGoalActivity(): void {
    this.pushControls();
    const active = this.isGoalActive();
    if (this.lastGoalActivity === active) return;
    this.lastGoalActivity = active;
    this.changed('goalActivity', active ? { active: true, goalId: this._currentGoalId } : { active: false });
  }

  /** True while a turn is running or this conversation owns an active goal. */
  private isGoalActive(): boolean {
    return this.turnPhase === 'busy' || this._currentGoalId !== undefined;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Ticket helpers
  // ═══════════════════════════════════════════════════════════════════

  private waitForTaskResult(ticketId: string, timeoutMs: number): Promise<{
    ticketId: string; success: boolean; result?: unknown; error?: string;
    steps: number; maxStepsReached?: boolean; validationErrors?: string[];
  }> {
    type TaskResult = { ticketId: string; success: boolean; result?: unknown; error?: string; steps: number; maxStepsReached?: boolean; validationErrors?: string[] };
    const early = this.takeTaskResult<TaskResult>(ticketId);
    if (early) return Promise.resolve(early);
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

  // ═══════════════════════════════════════════════════════════════════
  // Goal subscription (lazy, only while a goal is active)
  // ═══════════════════════════════════════════════════════════════════

  /** Subscribe to GoalManager once (idempotent). We never auto-unsubscribe,
   *  so a late outcome after the task returned still delivers; a single active
   *  conversation subscribing is cheap; the flood came from ALL of them. */
  private async ensureGoalSubscription(): Promise<void> {
    if (this._goalSubscribed || !this.goalManagerId) return;
    await this.request(request(this.id, this.goalManagerId, 'addDependent', {}));
    this._goalSubscribed = true;
  }

  /** Persist (or clear) the goal this conversation is running, so a lazily
   *  re-spawned Chat can reconnect to it after a restart. Best-effort. */
  private async persistActiveGoal(goalId: string | undefined): Promise<void> {
    if (!this.storageId || !this.conversationId) return;
    const key = `chats:activegoal:${this.conversationId}`;
    try {
      if (goalId) {
        await this.request(request(this.id, this.storageId, 'set', { key, value: goalId }));
      } else {
        await this.request(request(this.id, this.storageId, 'delete', { key }));
      }
    } catch { /* best effort */ }
  }

  /** On (lazy) spawn, re-attach to a goal left running by a prior session so
   *  its outcome still surfaces in this conversation. A marker pointing at an
   *  already-finished or missing goal is dropped. Idle conversations (no marker)
   *  return immediately and stay unsubscribed. */
  private async reconnectActiveGoal(): Promise<void> {
    if (!this.goalManagerId || !this.conversationId || !this.storageId) return;
    let activeGoalId: string | null = null;
    try {
      activeGoalId = await this.request<string | null>(
        request(this.id, this.storageId, 'get', { key: `chats:activegoal:${this.conversationId}` }),
      );
    } catch { return; }
    if (typeof activeGoalId !== 'string' || !activeGoalId) return;

    this._currentGoalId = activeGoalId;
    this.liveGoals.set(activeGoalId, { title: '(in progress)', status: 'active' });
    this.emitGoalActivity();
    await this.ensureGoalSubscription();
    const goal = await this.request<{ status?: string; title?: string; result?: unknown; error?: string } | null>(
      request(this.id, this.goalManagerId, 'getGoal', { goalId: activeGoalId }),
    );
    if (this._currentGoalId !== activeGoalId) return; // A terminal event won the race.
    if (!goal) {
      this._currentGoalId = undefined;
      this.liveGoals.delete(activeGoalId);
      this.emitGoalActivity();
      await this.persistActiveGoal(undefined);
      return;
    }
    this.liveGoals.get(activeGoalId)!.title = goal.title ?? '(in progress)';
    if (goal.status === 'completed' || goal.status === 'failed' || goal.status === 'archived') {
      await this.acceptGoalOutcome(activeGoalId, goal.status === 'failed' || goal.error ? 'failed' : 'completed', goal.result, goal.error);
      return;
    }
    this.goalPaused = goal.status === 'paused';
    this.activityActive = true;
    this.activityHeader = this.goalPaused ? 'Goal paused' : 'Waiting for goal progress';
    this.pushControls();
    this.fetchGoalTasks(activeGoalId).then(() => this.scheduleActivityRefresh()).catch(() => { /* GoalManager busy */ });
  }

  private async acceptGoalOutcome(goalId: string, status: 'completed' | 'failed', result?: unknown, error?: string): Promise<void> {
    const entry = this.liveGoals.get(goalId);
    if (!entry || entry.status === 'completed' || entry.status === 'failed') return;
    entry.status = status;
    entry.result = result;
    entry.error = error;
    this.recordGoalOutcome(goalId, entry.title, status, status === 'completed' ? result : error);
    this.scheduleActivityRefresh();
    if (goalId !== this._currentGoalId) return;
    const userStopped = this.stopRequestedGoalId === goalId;
    this.stopRequestedGoalId = undefined;
    this._currentGoalId = undefined;
    this.goalPaused = false;
    this.clarificationPending = false;
    this.emitGoalActivity();
    await this.persistActiveGoal(undefined);
    this.removeActivity();
    this.deliverLateGoalOutcome({ status, result, error, goalId });
    // The job lands: a burst on success, a glitch when it fell over (a stop
    // the user asked for is their own doing and plays nothing).
    if (status === 'completed') this.playEffect('burst');
    else if (!userStopped) this.playEffect('glitch');
    this.checkInvariants();
  }

  /**
   * Post a goal outcome that landed after the dispatching chat task already
   * returned, into the conversation where the user asked.
   */
  private deliverLateGoalOutcome(outcome: { result?: unknown; error?: string; status: 'completed' | 'failed'; goalId?: string }): void {
    const text = outcome.status === 'completed'
      ? (typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result))
      : `The goal did not complete: ${outcome.error ?? 'unknown error'}`;
    if (!text?.trim()) return;
    const id = uuidv4();
    this.conversationHistory.push({ id, role: 'assistant', content: text.trim(), sourceGoalId: outcome.goalId });
    this.appendMessage('assistant', 'Agent', text.trim(), true, id);
    this.schedulePersist();
  }

  /** Record a finished goal for planning context (newest last, capped at 8). */
  private recordGoalOutcome(goalId: string, title: string, status: 'completed' | 'failed', outcome?: unknown): void {
    const text = typeof outcome === 'string' ? outcome : outcome !== undefined ? JSON.stringify(outcome) : undefined;
    this.recentGoalOutcomes = this.recentGoalOutcomes.filter(g => g.goalId !== goalId);
    this.recentGoalOutcomes.push({
      goalId,
      title,
      status,
      finishedAt: Date.now(),
      resultPreview: text ? text.slice(0, 400) : undefined,
    });
    if (this.recentGoalOutcomes.length > 8) this.recentGoalOutcomes.shift();
  }

  /**
   * Live goal state for the planning LLM's observation. Covers the case
   * where a goal action's wait failed but the goal itself kept running or
   * has since finished: the observation carries the authoritative status
   * (and the full result on completion) so the LLM continues from reality
   * instead of re-creating equivalent goals.
   */
  private buildGoalStateObservation(): string {
    const lines: string[] = [];
    for (const [goalId, g] of this.liveGoals) {
      if (g.status === 'active') {
        const detail = [g.latestAgent && `agent: ${g.latestAgent}`, g.latestMessage]
          .filter(Boolean).join(' — ');
        lines.push(`- AWAITING OUTCOME: goal "${g.title}" (${goalId.slice(0, 8)})${detail ? ` — ${detail}` : ''}. Do NOT create a duplicate goal for this work; its status is active, which does not prove progress. Updates arrive through goal events; do not poll or create another goal.`);
      } else if (g.status === 'completed') {
        const result = typeof g.result === 'string' ? g.result : g.result !== undefined ? JSON.stringify(g.result) : '';
        const capped = result.length > 6000 ? `${result.slice(0, 6000)}\n…(truncated)` : result;
        lines.push(`- COMPLETED: goal "${g.title}" (${goalId.slice(0, 8)}). This work is DONE — even if an earlier step reported a wait timeout, do not redo it.${capped ? ` Result:\n${capped}` : ''}`);
      } else {
        lines.push(`- FAILED: goal "${g.title}" (${goalId.slice(0, 8)})${g.error ? ` — ${g.error}` : ''}`);
      }
    }
    if (lines.length === 0) return '';
    return `Current goal state (authoritative — trust this over earlier step results):\n${lines.join('\n')}`;
  }

  /** Fetch goal title and description from GoalManager when we lazily seed a goal entry. */
  private async fetchGoalTitle(goalId: string): Promise<void> {
    if (!this.goalManagerId) return;
    try {
      const goal = await this.request<{ id: string; title: string; description?: string; parentId?: string; status: string } | null>(
        request(this.id, this.goalManagerId, 'getGoal', { goalId })
      );
      if (goal) {
        const entry = this.liveGoals.get(goalId);
        if (entry) {
          entry.title = goal.title;
          if (goal.description) entry.description = goal.description;
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
        maxAttempts: (t.fields?.maxAttempts as number) ?? 1,
        dependsOn: (t.fields?.dependsOn as string[]) ?? undefined,
      }));
      this.liveTasks.set(goalId, tasks);
    } catch { /* GoalManager may not be ready */ }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Goal controls: pause, resume, stop, notes, clarification
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Pause: freeze the goal (GoalManager stops agents, claims, and scrums).
   * Messages sent while paused go to the goal as notes; resume continues.
   */
  private async pauseGoal(): Promise<boolean> {
    const goalId = this._currentGoalId;
    if (!goalId || !this.goalManagerId || this.goalPaused) return false;
    const ok = await this.request<boolean>(
      request(this.id, this.goalManagerId, 'pauseGoal', { goalId })
    ).catch(() => false);
    if (!ok) { this.playEffect('shake'); return false; }
    this.goalPaused = true;
    this.pushControls();
    this.appendMessage('assistant', 'Agent', 'Paused. Work has stopped. Send a note to steer the goal, then resume to continue or stop to end it.', false);
    return true;
  }

  private async resumeGoal(): Promise<boolean> {
    const goalId = this._currentGoalId;
    if (!goalId || !this.goalManagerId || !this.goalPaused) return false;
    const ok = await this.request<boolean>(
      request(this.id, this.goalManagerId, 'resumeGoal', { goalId })
    ).catch(() => false);
    if (!ok) { this.playEffect('shake'); return false; }
    this.goalPaused = false;
    this.clarificationPending = false;
    this.pushControls();
    return true;
  }

  /**
   * Stop: hard-stop the goal. GoalManager cancels every task and fails the
   * goal as "Stopped by user". The terminal event clears the goal state.
   */
  private async stopGoal(): Promise<boolean> {
    const goalId = this._currentGoalId;
    if (!goalId || !this.goalManagerId) return false;
    this.stopRequestedGoalId = goalId;
    const ok = await this.request<boolean>(
      request(this.id, this.goalManagerId, 'stopGoal', { goalId })
    ).catch(() => false);
    if (ok === false) {
      if (this.stopRequestedGoalId === goalId) this.stopRequestedGoalId = undefined;
      this.playEffect('shake');
      return false;
    }
    return true;
  }

  /**
   * The scrum master paused the goal to ask the user a question. Show it, and
   * take the next message as the answer (which resumes the goal).
   */
  private async handleClarificationRequested(question: string): Promise<void> {
    const goalId = this._currentGoalId;
    if (!goalId) return;
    this.goalPaused = true;
    this.clarificationPending = true;
    this.pushControls();
    this.appendMessage('assistant', 'Agent', question, true);
  }

  /**
   * A note during a running or paused goal: show it, keep it in the
   * conversation history, and queue it on the goal where the scrum master
   * weighs it. Answering a clarification question resumes the goal.
   */
  private async sendInterjection(note: string): Promise<void> {
    const goalId = this._currentGoalId;
    if (!goalId || !this.goalManagerId) return;
    const id = uuidv4();
    this.conversationHistory.push({ id, role: 'user', content: `[Note to the running goal] ${note}` });
    this.appendMessage('user', 'You', note, false, id);
    this.schedulePersist();
    const ok = await this.request<boolean>(
      request(this.id, this.goalManagerId, 'appendGoalNote', { goalId, note })
    ).catch(() => false);
    if (!ok) {
      this.appendMessage('error', 'Error', 'Could not deliver the note to the goal (it may have just finished).', false);
      this.playEffect('shake');
      return;
    }
    if (this.clarificationPending && this.goalPaused) {
      // The note answers the scrum master's question: resume the sprint so
      // the review scrum reads it.
      this.clarificationPending = false;
      const resumed = await this.request<boolean>(
        request(this.id, this.goalManagerId, 'resumeGoal', { goalId })
      ).catch(() => false);
      if (resumed) this.goalPaused = false;
      this.pushControls();
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Agent act handler
  // ═══════════════════════════════════════════════════════════════════

  private async handleAgentAct(action: AgentAction, caller: { id: AbjectId; taskId: string }): Promise<unknown> {
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

    // Goal creation is a short handoff. GoalManager events own the rest of
    // its lifecycle; no job queue or model loop waits for the sprint.
    if (action.action === 'goal') {
      const title = (action.title as string) ?? 'Untitled goal';
      const description = (action.description as string | undefined) ?? '';
      if (!this.goalManagerId) return { success: false, error: 'GoalManager not available' };
      if (!description.trim()) return { success: false, error: 'Goal action requires a non-empty description capturing the user intent and constraints.' };
      try {
        await this.ensureGoalSubscription();
        // A retried handoff must reuse the goal this conversation already owns.
        if (!this._currentGoalId) {
          // Capture the actual conversation, independently of the model's prose.
          // Persisting it with the goal also survives closing/clearing the chat.
          const context = this.turnContext ?? this.captureGoalContext();
          const created = await this.request<{ goalId: string }>(request(this.id, this.goalManagerId, 'createGoal', {
            title: title.slice(0, 200), description, operationId: `chat:${caller.taskId}`,
            ...(context ? { context } : {}),
          }));
          this._currentGoalId = created.goalId;
          this.goalPaused = false;
          this.liveGoals.set(created.goalId, { title, description, status: 'active' });
          this.emitGoalActivity();
        }
        const goalId = this._currentGoalId;
        this._goalCreatedThisTurn = true;
        await this.persistActiveGoal(goalId);
        this.showActivity();
        this.updateActivityHeader('Goal submitted — waiting for progress');
        this.activityStep = 0;
        this.stepStreamChars = 0;
        // Reconcile once after subscribing: completion may beat createGoal's reply.
        const goal = await this.request<{ status?: string; result?: unknown; error?: string } | null>(
          request(this.id, this.goalManagerId, 'getGoal', { goalId }), 5000,
        ).catch(() => null);
        if (goal?.status === 'completed' || goal?.status === 'failed') {
          await this.acceptGoalOutcome(goalId, goal.status, goal.result, goal.error);
        }
        // The goal widget acknowledges the handoff; its final synthesis will
        // arrive as a separate event, without another Chat model call.
        return { success: true, data: '' };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    return { success: false, error: `Unknown action: ${action.action}` };
  }

  // ═══════════════════════════════════════════════════════════════════
  // System prompt
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Whether this instance has a display, asked of InstanceInfo (cached for a
   * minute). A headless instance has no windows, desktop scene or taskbar, so
   * the prompt stops offering them. Without InstanceInfo to ask, the answer
   * stays what it always was: a desktop.
   */
  private async hasDisplay(): Promise<boolean> {
    const now = Date.now();
    if (this.displayCheck && now - this.displayCheck.at < DISPLAY_CHECK_TTL_MS) return this.displayCheck.display;
    let display = this.displayCheck?.display ?? true;
    this.instanceInfoId = await this.resolveDep('InstanceInfo', this.instanceInfoId);
    if (this.instanceInfoId) {
      try {
        const info = await this.request<{ display?: boolean }>(request(this.id, this.instanceInfoId, 'getInfo', {}), 5000);
        if (typeof info?.display === 'boolean') display = info.display;
      } catch { this.instanceInfoId = undefined; }
    }
    this.displayCheck = { at: now, display };
    return display;
  }

  private buildSystemPrompt(desktop: boolean): string {
    const now = new Date();
    const dateLine = now.toLocaleDateString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    });
    const isoDate = now.toISOString().slice(0, 10);
    const recentGoalsBlock = this.recentGoalOutcomes.length === 0 ? '' : `

## Recently Finished Goals (this session)

Work already done — check here BEFORE creating a goal, and build on these outcomes instead of repeating them:
${this.recentGoalOutcomes.map(g => `- [${g.status}] "${g.title}"${g.resultPreview ? ` — ${g.resultPreview}` : ''}`).join('\n')}`;
    return `You are Chat Agent, a helpful assistant inside the Abjects system. You help users by creating goals and routing tasks to specialized agents. You do not carry out actions yourself; you route them.

Current date: ${dateLine} (${isoDate}). When the user mentions relative times ("today", "tomorrow", "next week", "in 3 days"), resolve them against this date.${recentGoalsBlock}

A \`goal\` action ends this routing turn once GoalManager accepts it. The chat receives progress and the final result through bus events. Do not poll goal status or narrate unobserved progress.

${desktop ? DESKTOP_SCENE_PROMPT : ''}## Action Format

Respond with ONE action as a JSON object in a \`\`\`json code block. Output ONLY the JSON block — no prose before or after it. Put a one-sentence note in the action's \`reasoning\` field if you want it logged; the prose around the block is unread.

\`\`\`json
{ "action": "done", "text": "Hello! How can I help you?" }
\`\`\`

## You route, you do not act (and you cannot see)

When writing a goal, preserve the user's outcome and explicit constraints. Recalled project facts and command suggestions are historical context, not additional user requirements. Let the owning agent discover current scripts and capabilities and reuse applicable passing checks. Do not require an old workaround or exact validation command unless the user asked for it. When reporting completion, include the owner's verification evidence, including passing background checks and test totals.

For approval of an earlier proposal, make the goal execute that accepted proposal. Carry forward its source goal/message reference and the user's amendments; the originating conversation is attached automatically. Do not turn "make these commits" or "apply that plan" into a new investigation or a request to propose alternatives. Earlier findings are inputs to this goal; only its new results establish that execution happened.

You have no hands and no eyes in this system. You cannot navigate a slide, open or move a window, click anything, change anything, or look at the screen, any window, or any live state. Every real action and every real observation happens inside a **goal** you create: the goal runs on the agents, and the result it returns is your ONLY source of truth about what actually happened.

So:
- Report only what a goal returned this turn. If you created no goal, nothing has happened yet, so there is nothing to confirm.
- Make claims about the real world only from a goal result. "Done", "you're now on slide 11", "it's open", "moved it", "verified on the live window" all assert that something really happened. State them only when a goal you created returned that outcome. Never invent a status, a screen reading, a nav-bar value, or a verification.
- Treat a repeat-looking request as its own action. Earlier turns are history, not proof the new action occurred. "Now take me to slide 11" is a fresh navigation: create the goal, then report what it returns.
- When you cannot ground a claim in a goal result, create the goal, or say plainly what you are doing or asking. Do not narrate an outcome you did not observe.

**\`submit_job\` is available to you, and it is rarely the right move.** It runs code that messages objects, so it can read live state, and that makes it look like a way to answer a question about the system yourself. A goal gets the user a better answer: it runs on the agents that hold the tools, the permissions and the domain knowledge for that work, and it comes back synthesized. Reach for \`submit_job\` only when one small mechanical read decides WHICH goal to write and the user is not waiting on what it returns, and keep it to that single step. Chaining jobs, reading their results and building a theory is an agent's work happening inside your routing turn: write the goal instead and let it run.

**A question about the system is still a goal.** "Why didn't X run", "is Y still scheduled", "what happened to Z" all ask for an investigation, and an investigation is what a goal is for. The finding reaches the user through the goal result, the same as any other outcome.

## Available Actions

### Agent Work
- **goal**: Express the user's intent as a goal. You're the Product Owner — define WHAT needs to happen. ScrumMaster runs scrums to plan and execute the work, then synthesizes a final result.

  You provide:
  - **title** (required): a short user-facing label (~200 chars). Used in lists / UI.
  - **description** (required): the user's intent in detail, in their words where possible. Include any explicit ordering ("do A then B then C"), constraints, examples, and what success looks like. ScrumMaster's planning LLM reads this to decide the sprint backlog — the richer and more concrete the description, the better the plan. Never leave this empty.

  Do NOT pre-decide tasks. ScrumMaster owns task decomposition; the team's capabilities inform how the work splits, not your guess.

  Simple request:
  \`{ "action": "goal", "title": "Current weather", "description": "Tell me the current weather for my location (Silverdale, WA). Include temperature, conditions, and a brief outlook for today." }\`

  Multi-step intent (express ordering as prose, ScrumMaster will plan accordingly):
  \`{ "action": "goal", "title": "News digest", "description": "Fetch the latest top news headlines, then write a brief one-paragraph summary of the day's stories. The summary should be readable in under a minute." }\`

  Diagnose-then-fix:
  \`{ "action": "goal", "title": "Diagnose and fix auth bug", "description": "Investigate the auth failure: find the file, line number, and root cause. Then apply the fix and verify the change. Done means the auth flow works end-to-end." }\`

  Concrete user data (email, calendar, files, contacts, weather, web pages, finances, etc.):
  ALWAYS attempt via a goal — specialized agents and MCP-backed skills may be available that you don't know about.
  \`{ "action": "goal", "title": "Latest email", "description": "Fetch my most recent email and report sender, subject, received time, and a short summary of the body." }\`

### Memory
- **remember**: Save a durable fact to the knowledge base. \`remember\` is non-terminal — after it saves you keep going in the same turn, so the natural pattern is to remember first and then \`reply\`/\`done\`. Saving costs you nothing toward the reply. Use your judgment about what is worth keeping: a passing remark or one-off request usually is not, but a standing fact about the user (their name, where they live, how they want to be addressed, a stable preference) is worth saving the moment you learn it. When the user tells you their name, save it before you greet them back.
  Step 1 — save: \`{ "action": "remember", "title": "User's name is Jordan Lee", "content": "The user said their name is Jordan Lee.", "type": "fact", "tags": ["user", "name"] }\`
  Step 2 — then reply: \`{ "action": "done", "text": "Nice to meet you, Jordan!" }\`
  Types: 'fact' (personal info, discovered truths), 'learned' (lessons from outcomes), 'insight' (patterns), 'reference' (pointers)

### Communication
- **clarify**: Ask the user a clarifying question before proceeding. Use when the answer is
  one only they hold — which of their own things they meant, what outcome they want, an
  irreversible choice. When the system could settle it instead (which object or skill, whether
  something exists here, what some state is), create a goal and find out. The user will see
  your question and respond.
  \`{ "action": "clarify", "question": "Did you mean X or Y?", "assumptions": [
    { "assumption": "User wants to modify the existing Counter", "confidence": "high" },
    { "assumption": "The reset should set count to zero", "confidence": "low" }
  ] }\`
- **reply**: Send intermediate text to the user (continue working after).
  \`{ "action": "reply", "text": "Working on it, I've created the goal..." }\`
- **done**: Task complete, send final reply. The user can only see what you put in the done text.
  \`{ "action": "done", "text": "Here are the results: ..." }\`
  Everything you assert in done text about an action or an outcome must trace to a goal result from this conversation. With no goal run this turn, done text may greet, answer from known facts, or acknowledge and ask, but it may not claim an action happened or was verified. If the user asked you to DO something and you have no goal result yet, you are not done: create the goal instead.
  When the goal returned a result, present it to the user in full. You have plenty of output tokens (16K+) to include everything. Format the result for readability: markdown tables, lists, headers as appropriate. Rephrase or translate raw data (JSON, logs) into natural language when it helps the user. Include every item and every requested field. If the user asked for 5 items, show all 5. If the user asked for full content, show full content. Trust your output capacity; the result fits.

  **Self-contained text rule.** The done text is the user's ONLY view of the result. Do not reference internal artifacts the user can't see — no "see above", "see the prioritized list", "see scratchpad", "see goal X", "see the attached", "as shown earlier". The user has not seen anything earlier; they only see this reply. If the goal result or scratchpad contains a list, table, or detailed data the user asked for, INLINE it directly in the done text. Pull values out of the scratchpad and write them into your reply.

Replies render as markdown, on the desktop and in the terminal. Use **bold**, *italic*, \`inline code\`, headings, bullet lists, code blocks, and [links](url) in your reply and done text for readable formatting.

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

Before creating a goal, consider what assumptions you are making. For each, estimate your confidence (high/medium/low), and ask where the answer lives.

**Assumptions the system can settle belong in a goal, not a question.** Which object, agent, or skill the user means; whether something exists here; what a tool reports; what some state currently is. You have no picture of what is installed, and that is exactly why these go to the team: a goal finds out and tells you. Asking the user to identify something the system already has installed asks them to do a lookup on your behalf. If the goal comes back without it, you then have a real finding to put a question on top of.

**Assumptions only the user can settle belong in \`clarify\`.** Which of several things of THEIR own they meant, what outcome they actually want, a preference between approaches you cannot rank for them, and anything irreversible you would rather confirm than guess at.

Create a goal: which existing object or skill they are referring to; whether some capability is present; what the current state of something is.
Clarify: what specific behavior or appearance they want; whether they want a new object or a change to an existing one; which of two of their accounts, files, or projects is meant.

When an assumption could be settled by trying, try. A goal that comes back empty is a better basis for a question than a guess about what you do not have.

You do not need to clarify simple greetings, direct questions, or unambiguous requests.

## Rules

1. Always respond with valid JSON in a \`\`\`json block. ONE action per response. Never reply with bare prose — even your final answer must be wrapped in \`{ "action": "done", "text": "..." }\`.
2. For simple greetings, use **done** directly. For questions about objects or the system, create a **goal** to investigate rather than guessing. You do not have knowledge of what objects exist or what they can do. Always use the system to find out.
3. When the user asks you to DO something (navigate, open, show, move, change, fetch, run, take me to), create a **goal** immediately with well-described tasks, even when the request looks like a repeat of an earlier turn. You cannot do it yourself, and you cannot see whether it happened; the goal is the only way it happens and the only way you learn the outcome. Report the outcome only from what that goal returns.
4. **Trust the team to try.** Your toolset is dynamic — agents and MCP-backed skills come and go (email, calendar, contacts, finance, web, etc.). When the user asks for concrete data or an action, your first move is always a goal. Report capability limits only after a real goal has run and produced a real failure — then quote that failure and offer to create the missing agent.

   This applies to confident-sounding capability claims about the OUTSIDE world too. Predictions about how an external service will react ("site X blocks headless browsers", "Y rate-limits aggressively", "the API has restrictive scopes", "browser automation is fragile and ToS-adjacent", "no LinkedIn/Gmail/bank integration is possible") are training-data speculation, not evidence. Keep them out of your reply.

   The system has a web-automation agent with persistent browser profiles that retain logins across sessions. For requests like "read my LinkedIn inbox" / "log into Gmail" / "open my bank dashboard", the correct response is a goal that names the site and a profile (e.g. \`profile: 'linkedin'\`) and lets the agent try. If a real attempt later returns a real error, quote that error in your follow-up and offer a concrete next step. Until that happens, give a one-line acknowledgement and dispatch the goal.
5. Always end a conversation turn with **done** when the task is complete.
6. Output ONLY the JSON block. Any one-sentence note belongs in the JSON's \`reasoning\` field.
7. If a goal's tasks fail, you can retry by creating a new goal with a simpler task description. If it fails repeatedly, use "done" to tell the user what happened — quoting the actual failure message, not a guess.

## Stop when the work is done

When the user asked for an object, app, widget, bridge, tool, schedule, or agent and the goal finishes successfully, the work is done. The object is registered; ${desktop ? 'the user can discover and open it from the taskbar, AppExplorer, or by asking' : 'the user reaches it by asking in this conversation, on a schedule, or through the web gateway'}. On the very next turn, call **done** with:
- the object's name exactly as registered,
- a one-line summary of what it does,
- ${desktop ? 'how to open it (taskbar, AppExplorer, or "ask me to open it")' : 'how to use it (ask me to call it, or schedule it)'}.

Treat the user's silence as confirmation. Wait for the user to report a specific issue before revisiting the object — their feedback is the signal to retry or refine.

Save method-call follow-ups (show, hide, refresh, update) for turns when the user explicitly asks. If the user says "open it" or "show me X" or "run X", then create a goal whose task description names the target object and the method, e.g. *"Call show() on the FooWidget object to open its window"*.

A single successful creation goal is a complete turn. End it with **done**.
8. P2P: Resolve remote objects by qualified name: this.find('peer.workspace.ObjectName'). Always use find() for dynamic ID resolution.
9. When the user shares a standing personal fact (their name, where they live, preferences, job), remember it in that same turn before you reply, so future conversations can recall it. Use your judgment; not every message carries something worth saving, but a fact like a name clearly is.
10. Task descriptions should describe the desired outcome and timing, letting agents decide implementation. Example: "Post a weather briefing to chat every day at 10:30 AM" is better than "Use setInterval to check the time every minute".`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Persistence and title
  // ═══════════════════════════════════════════════════════════════════

  private notifyRectChanged(): void {
    if (!this.initialRect || !this.chatManagerId || !this.conversationId) return;
    if (this.rectPersistTimer) return;
    this.rectPersistTimer = this.setTimer(() => {
      this.rectPersistTimer = undefined;
      if (!this.initialRect || !this.chatManagerId || !this.conversationId) return;
      this.send(event(this.id, this.chatManagerId, 'rectChanged', {
        conversationId: this.conversationId,
        rect: { ...this.initialRect },
      }));
    }, 250);
  }

  private schedulePersist(): void {
    if (!this.conversationId || !this.storageId) return;
    if (this.persistTimer) return;
    this.persistTimer = this.setTimer(() => {
      this.persistTimer = undefined;
      void this.persistHistory();
    }, 200);
  }

  private async persistHistory(): Promise<void> {
    if (!this.conversationId || !this.storageId) return;
    this.conversationHistory = identifyMessages(this.conversationId, this.conversationHistory);
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
    const derived = cleaned.length > 40 ? cleaned.slice(0, 40).trimEnd() + '…' : cleaned;
    this.conversationTitle = derived;
    if (this.chatManagerId) {
      this.send(event(this.id, this.chatManagerId, 'titleChanged', {
        conversationId: this.conversationId,
        title: derived,
      }));
    }
    this.changed('titleChanged', { conversationId: this.conversationId, title: derived });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Attachments
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Persist an uploaded file to the workspace FileSystem and record it as an
   * attachment in the conversation. The full content is injected into the LLM
   * context once on the next turn (see `runChatTask`), then referenced by name.
   */
  private async handleFileUploaded(name: string, mimeType: string, base64: string): Promise<void> {
    if (!this.fileSystemId) {
      this.appendMessage('error', 'Upload', 'No filesystem available to store the file.', false);
      this.playEffect('shake');
      return;
    }
    const safeName = name.replace(/[/\\]/g, '_');
    const convo = this.conversationId ?? this.id;
    const path = `/uploads/${convo}/${safeName}`;
    try {
      await this.request(
        request(this.id, this.fileSystemId, 'writeFileBytes', { path, base64 }),
        30000,
      );
    } catch (err) {
      log.warn(`[Chat] failed to store upload ${safeName}:`, err);
      this.appendMessage('error', 'Upload', `Failed to store "${safeName}".`, false);
      this.playEffect('shake');
      return;
    }

    const kind: 'text' | 'image' | 'document' =
      IMAGE_MIME.has(mimeType) ? 'image' :
      mimeType === 'application/pdf' ? 'document' : 'text';

    const id = uuidv4();
    this.conversationHistory.push({
      id,
      role: 'user',
      content: `${ATTACH_GLYPH} Attached ${safeName}`,
      sender: 'You',
      attachment: { path, name: safeName, mimeType, kind, injected: false },
    });
    this.appendMessage('user', 'You', `${ATTACH_GLYPH} Attached **${safeName}**`, true, id);
    this.schedulePersist();
    // Saved: a hand-coloured flash as the attachment lands.
    this.playEffect('flash', '$accent');
  }

  /**
   * Images pasted with a message: store the bytes in the workspace FileSystem
   * (so the LLM gets a vision block from the file path) and show each as an
   * inline image message. The message carries a `data:` URI directly, since a
   * view cannot reliably reach the FileSystem to resolve a reference.
   */
  private async commitImages(images: ChatImage[]): Promise<void> {
    for (const img of images) {
      const safeName = (img.name || 'image').replace(/[/\\]/g, '_');
      const mimeType = IMAGE_MIME.has(img.mimeType) ? img.mimeType : 'image/png';
      const dataUri = `data:${mimeType};base64,${img.base64}`;

      // Store the bytes so the LLM receives a vision block read from the path.
      let path: string | undefined;
      if (this.fileSystemId) {
        const convo = this.conversationId ?? this.id;
        path = `/uploads/${convo}/${Date.now()}-${safeName}`;
        try {
          await this.request(
            request(this.id, this.fileSystemId, 'writeFileBytes', { path, base64: img.base64 }),
            30000,
          );
        } catch (err) {
          log.warn(`[Chat] failed to store pasted image ${safeName}:`, err);
          path = undefined;
        }
      }

      const id = uuidv4();
      this.conversationHistory.push({
        id,
        role: 'user',
        content: `![${safeName}](${dataUri})`,
        sender: 'You',
        // With a stored path the attachment carries the image to the LLM (as a
        // vision block, not the inline data URI). Without one, mark it media so
        // the heavy data URI never enters the LLM context.
        ...(path
          ? { attachment: { path, name: safeName, mimeType, kind: 'image' as const, injected: false } }
          : { media: true }),
      });
      this.appendMessage('user', 'You', `![${safeName}](${dataUri})`, true, id);
    }
    this.schedulePersist();
  }

  /**
   * Read an attachment from the FileSystem and shape it into LLM content:
   * text/code inline (truncated), images and PDFs as binary content parts.
   * Returns null if the file can't be read (caller falls back to a reference).
   */
  private async buildAttachmentContent(att: {
    path: string; name: string; mimeType: string; kind: 'text' | 'image' | 'document';
  }): Promise<string | ContentPart[] | null> {
    if (!this.fileSystemId) return null;
    try {
      if (att.kind === 'text') {
        const text = await this.request<string>(
          request(this.id, this.fileSystemId, 'readFile', { path: att.path }), 30000);
        const body = text.length > MAX_ATTACHMENT_CHARS
          ? text.slice(0, MAX_ATTACHMENT_CHARS) + '\n…[truncated]'
          : text;
        return `Attached file ${att.name}:\n\`\`\`\n${body}\n\`\`\``;
      }
      const base64 = await this.request<string>(
        request(this.id, this.fileSystemId, 'readFileBytes', { path: att.path }), 30000);
      if (att.kind === 'image') {
        return [
          { type: 'text', text: `Attached image: ${att.name}` },
          { type: 'image', mediaType: att.mimeType, data: base64 } as ContentPart,
        ];
      }
      return [
        { type: 'text', text: `Attached document: ${att.name}` },
        { type: 'document', mediaType: 'application/pdf', data: base64, name: att.name } as ContentPart,
      ];
    } catch (err) {
      log.warn(`[Chat] failed to read attachment ${att.name}:`, err);
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // A turn
  // ═══════════════════════════════════════════════════════════════════

  private captureGoalContext(): ConversationContext | undefined {
    this.conversationHistory = identifyMessages(this.conversationId ?? this.id, this.conversationHistory);
    return this.conversationHistory.length ? captureConversation(this.conversationId ?? this.id, this.conversationHistory) : undefined;
  }

  /** Run one Chat OTA turn with a fixed handoff context, including during model latency. */
  private async runTaskTurn(
    userText: string,
    messages: { role: string; content: string | ContentPart[] }[],
    desktop: boolean,
  ): Promise<ChatTurn> {
    this._goalCreatedThisTurn = false;
    this._streamBuffer = '';
    this.turnContext = this.captureGoalContext();
    try {
      const { ticketId } = await this.request<{ ticketId: string }>(
        request(this.id, this.agentAbjectId!, 'startTask', {
          task: userText,
          systemPrompt: this.buildSystemPrompt(desktop),
          initialMessages: messages,
          goalId: undefined,
          config: { queueName: `chat-${this.id}` },
        }),
        60000,
      );
      this._currentTicketId = ticketId;
      const result = await this.waitForTaskResult(ticketId, 180000);
      this._currentTicketId = undefined;
      return {
        success: result.success,
        result: result.result,
        error: result.error,
        maxStepsReached: result.maxStepsReached,
        goalCreated: this._goalCreatedThisTurn,
      };
    } finally {
      this.turnContext = undefined;
    }
  }

  /**
   * Cheap prefilter for the self-audit: does this reply assert that an action
   * was performed, report live/UI state, claim a verification, or declare that
   * something is missing — things Chat can only truthfully know from a goal it
   * ran? Greetings, questions, and answers built from given facts won't match,
   * so they skip the extra check. This only decides whether the one audit
   * re-prompt is worth running; the model makes the real call there. It is a
   * soft prefilter, not a hard block.
   *
   * Absence counts because "there is no such object" is a report on live state
   * just as much as "I opened it", and Chat's own lookups cannot establish it:
   * a registered name says nothing about capabilities acquired since
   * registration, so a miss is a fact about a spelling, not about the system.
   */
  private mightBeUngroundedClaim(text: string): boolean {
    return looksLikeClaim(text) || looksLikeAbsenceClaim(text);
  }

  /**
   * Whether a goal-less reply gets the audit re-prompt (site chat.audit). The
   * claim shapes above stay the floor. A decision model reads paraphrase and
   * promises the shapes miss: advising, it can only add an audit; acting, it
   * may also skip one the shapes flagged on a reply it reads as clean. When
   * the shapes see nothing, only a real decision model is worth the wait.
   */
  private async shouldAuditReply(userText: string, draft: string): Promise<boolean> {
    const shaped = this.mightBeUngroundedClaim(draft);
    const mode = await this.decisionSiteMode('chat.audit');
    if (mode === 'off') return shaped;
    // Advising can only add an audit, so a shaped reply is audited either way.
    if (mode === 'advise' && shaped) return true;
    // An emulated reading costs a chat-model call: worth it only where acting
    // on it can skip the re-prompt the shapes asked for.
    const nativeOnly = !(mode === 'act' && shaped);
    const recent = this.conversationHistory.filter(e => e.media !== true).slice(-7, -1)
      .map(e => ({ role: e.role, content: e.content.slice(0, 300) }));
    const outcome = await this.askDecision('chat.audit', {
      request: userText.slice(0, 1500), text: draft.slice(0, 4000), recent,
    }, replyKindQuestions(), { onBehalfOf: 'Chat', nativeOnly });
    const kind = choiceOf(outcome, 'reply_kind');
    if (!outcome || !kind) return shaped;
    const p = kind.probabilities[kind.choice] ?? 0;
    // One reading decides: audit what claims an unrun action, an absence, or
    // a promise; trust what reads as an answer, a question, or conversation.
    const flagged = (REPLY_KINDS_TO_AUDIT as readonly string[]).includes(kind.choice) && p >= 0.6;
    const clean = !flagged && p >= 0.8;
    log.info(`[decision:${outcome.mode}] chat.audit: ${kind.choice}@${p.toFixed(2)} → ${flagged ? 'audit' : clean ? 'deliver' : 'shapes decide'} (shapes=${shaped})`);
    if (outcome.mode === 'advise') return shaped || flagged;
    if (flagged) return true;
    return clean ? false : shaped;
  }

  /**
   * How to handle a user message (site chat.route). Acting, a clear and
   * self-contained request becomes a goal directly, skipping the routing
   * think; otherwise (or advising) the verdict rides to that think as a hint.
   */
  private async routeAndRunTurn(
    userText: string, initialMessages: { role: string; content: string | ContentPart[] }[], newAttachment: boolean, desktop: boolean,
  ): Promise<ChatTurn> {
    const mode = userText.trim() ? await this.decisionSiteMode('chat.route') : 'off';
    if (mode === 'off') return this.runTaskTurn(userText, initialMessages, desktop);
    const r = await this.decideRoute(userText, newAttachment);
    if (r) log.info(`[decision:${r.outcome.mode}] chat.route: ${r.route}@${r.routeP.toFixed(2)}`);
    if (r && r.outcome.mode === 'act' && r.route === 'goal_self_contained' && r.routeP >= 0.9 && !newAttachment) {
      log.info('[decision:act] chat.route: creating the goal directly');
      return this.createRoutedGoal(userText, desktop);
    }
    const hinted = r && r.routeP >= 0.8
      ? [...initialMessages, { role: 'user', content: `[Routing hint] A runtime check reads this message as ${ROUTE_HINTS[r.route] ?? r.route} (p=${r.routeP.toFixed(2)}). Decide as usual.` }]
      : initialMessages;
    return this.runTaskTurn(userText, hinted, desktop);
  }

  private async decideRoute(userText: string, newAttachment: boolean): Promise<{ outcome: DecisionOutcome; route: string; routeP: number } | null> {
    const recent = this.conversationHistory.filter(e => e.media !== true).slice(-7, -1)
      .map(e => ({ role: e.role, content: e.content.slice(0, 500) }));
    const recentGoals = [...this.liveGoals.values()].slice(-3).map(g => ({ title: g.title, status: g.status }));
    const outcome = await this.askDecision('chat.route', {
      message: userText.slice(0, 3000), recent, recent_goals: recentGoals, has_new_attachment: newAttachment,
    }, CHAT_ROUTE_QUESTIONS, { onBehalfOf: 'Chat' });
    const route = choiceOf(outcome, 'route');
    if (!outcome || !route) return null;
    return { outcome, route: route.choice, routeP: route.probabilities[route.choice] ?? 0 };
  }

  /**
   * A goal created without the routing think: the user's words verbatim as
   * the description (the conversation rides along as context, as it does for
   * any goal), and a title cut from the first line.
   */
  private async createRoutedGoal(userText: string, desktop: boolean): Promise<ChatTurn> {
    this._goalCreatedThisTurn = false;
    this.turnContext = this.captureGoalContext();
    try {
      const firstLine = userText.split('\n').find(l => l.trim())?.trim() ?? userText.trim();
      const title = firstLine.length > 80 ? `${firstLine.slice(0, 80).trimEnd()}…` : firstLine;
      const outcome = await this.handleAgentAct({ action: 'goal', title, description: userText.trim() } as AgentAction, { id: this.id, taskId: `route-${uuidv4()}` }) as { success: boolean; error?: string };
      if (!outcome.success) {
        // Fall back to the normal turn: nothing was created.
        return this.runTaskTurn(userText, this.conversationHistory.filter(e => e.media !== true).slice(-MAX_CONVERSATION_ENTRIES).map(e => ({ role: e.role, content: e.content })), desktop);
      }
      return { success: true, result: '', goalCreated: this._goalCreatedThisTurn };
    } finally {
      this.turnContext = undefined;
    }
  }

  /**
   * The audit re-prompt. Hands the model its own drafted reply and asks it to
   * either ground the claim by creating a real goal, or confirm the reply if
   * it was only conversational. Leans on the model's ability to recognize its
   * own ungrounded claim when asked point-blank.
   */
  private buildAuditPrompt(draft: string): string {
    return `Before this reply reaches the user, audit it:\n\n"${draft}"\n\nYou created NO goal this turn, so you did not actually perform any action or observe any live state. Two things to check, and either one means this reply is not ready:\n\n1. Does it claim an action was done, report the state of a window/screen/deck, or say something was "verified"?\n2. Does it tell the user something is missing, unavailable, not installed, not registered, or beyond reach?\n\nThe second is a report on live state exactly as much as the first, and you cannot establish it from here. A name that failed to resolve means nothing is registered under that spelling — it does not mean the system lacks the capability, because a registered name cannot see a skill, tool, or connection acquired after registration, and much of what this system can do is reached through an agent rather than an object of that name.\n\nIf either is YES, respond now with a \`goal\` action that actually attempts what the user asked, and report the outcome — including a genuine inability — only from what that goal returns. If the reply is only a greeting, a question, or an answer built from facts already in this conversation, it's fine — respond with the same \`done\` unchanged.`;
  }

  private async runChatTask(userText: string): Promise<void> {
    if (this.turnPhase !== 'idle') return;
    this.turnPhase = 'busy';
    this.emitGoalActivity();

    // The user's message joins the transcript. Skipped when empty (an
    // image-only send, where the image messages were already committed).
    if (userText) {
      const id = uuidv4();
      this.conversationHistory.push({ id, role: 'user', content: userText });
      this.appendMessage('user', 'You', userText, false, id);
      this.schedulePersist();
      this.maybeAutoTitle(userText);
    }

    this.showActivity();

    try {
      const desktop = await this.hasDisplay();
      // Build initial messages: conversation history + new user message.
      const initialMessages: { role: string; content: string | ContentPart[] }[] = [];
      // Filter media-only entries (images/screenshots persisted for re-render
      // but not part of the LLM-visible conversation). Their data URIs would
      // balloon every prompt with no semantic gain; the originating agent
      // already pushed a text summary into conversationHistory separately.
      const recent = this.conversationHistory
        .filter(e => e.media !== true)
        .slice(-MAX_CONVERSATION_ENTRIES);
      let attachmentsInjected = false;
      for (const entry of recent) {
        if (entry.attachment) {
          // Inject the full file content once; reference it by name thereafter.
          const content = entry.attachment.injected
            ? null
            : await this.buildAttachmentContent(entry.attachment);
          if (content) {
            initialMessages.push({ role: 'user', content });
            entry.attachment.injected = true;
            attachmentsInjected = true;
          } else {
            initialMessages.push({ role: 'user', content: `[Attached earlier: ${entry.attachment.name} at ${entry.attachment.path}]` });
          }
          continue;
        }
        initialMessages.push({ role: entry.role, content: entry.content });
      }
      // Persist the flipped `injected` flags so a reload doesn't re-send bytes.
      if (attachmentsInjected) this.schedulePersist();

      // Goal is created on the first `goal` action — Chat creates it via
      // GoalManager.createGoal, ScrumMaster runs the scrum cycle (plan,
      // execute, plan again or declare done), and emits goalCompleted.
      let turn = await this.routeAndRunTurn(userText, initialMessages, attachmentsInjected, desktop);

      // Self-audit: a `done` that reports an action or a verified outcome but
      // ran NO goal this turn is ungrounded — the model can't have done or
      // observed anything without a goal, so it confabulated. Re-prompt once,
      // letting the model catch its own claim and route it as a real goal.
      // Scoped to goal-less, claim-shaped replies so greetings/answers skip it.
      if (turn.success && !turn.goalCreated) {
        const draft = (turn.result as string) ?? '';
        if (draft && await this.shouldAuditReply(userText, draft)) {
          log.info('[Chat] self-audit: goal-less claim-shaped reply — re-prompting to ground or route');
          const auditMessages = [
            ...initialMessages,
            { role: 'assistant', content: draft },
            { role: 'user', content: this.buildAuditPrompt(draft) },
          ];
          turn = await this.runTaskTurn(userText, auditMessages, desktop);
        }
      }

      const result = turn;

      // The goal and its controls outlive the short Chat routing task.
      if (!this._currentGoalId) this.removeActivity();

      if (result.success) {
        const text = (result.result as string) ?? '';
        if (text) {
          const id = uuidv4();
          this.conversationHistory.push({ id, role: 'assistant', content: text });
          this.appendMessage('assistant', 'Agent', text, true, id);
          this.schedulePersist();
        }
      } else {
        const errorText = (result.error ?? 'Unknown error').slice(0, 200);
        const note = result.maxStepsReached ? ' (step limit reached)' : '';
        this.appendMessage('error', 'Error', errorText + note, false);
        this.playEffect('glitch');
        await this.notify(
          result.maxStepsReached ? 'Agent stopped: step limit reached' : 'Agent error',
          'error',
        );
      }
    } catch (err) {
      this._currentTicketId = undefined;
      if (!this._currentGoalId) this.removeActivity();
      const errMsg = err instanceof Error ? err.message : String(err);
      this.appendMessage('error', 'Error', errMsg.slice(0, 200), false);
      this.playEffect('glitch');
      await this.notify(`Chat error: ${errMsg.slice(0, 80)}`, 'error');
    }

    this.turnPhase = 'idle';
    this.emitGoalActivity();
    this.checkInvariants();
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

### Show / hide the Chat window (on a desktop; show returns false where there is no display)

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

Chat emits a \`messageAdded\` event every time a message joins the conversation. This is the hook for forwarding Chat traffic to an external channel (Telegram, SMS, email, another messaging service). Subscribe via \`addDependent\` and you receive every user message, every assistant reply, every system notification, and every error.

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
- **error**: an error surfaced in the conversation.

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
