/**
 * ChatWindow — the desktop view of one Chat conversation.
 *
 * Chat is the conversation (history, goals, the agent loop) and draws
 * nothing; this object draws it. It subscribes to its Chat, renders every
 * `messageAdded` as a bubble, shows the live activity and the composer state
 * Chat sends it, and turns what the person does here (typing, pasting images,
 * pause / resume / stop, closing the window) into messages to Chat.
 *
 * Chat spawns it on `show` and kills it on `hide`; it exists only where there
 * is a display. Model and view are two abjects, so a conversation runs the same
 * with this window, with a terminal, or with nothing attached.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { require as precondition, invariant } from '../core/contracts.js';
import { Capabilities } from '../core/capability.js';
import { estimateWrappedLineCount } from './widgets/word-wrap.js';
import { buildGoalRows, type GoalNode } from './goal-tree.js';
import { estimateMarkdownHeight } from './widgets/markdown.js';
import { chromeCase } from '../core/theme-data.js';
import { sectionHeaderText, livingStyle, eyeSigilOps, removeSigilOps, type SceneOp, sigilStreamOps } from './ui-kit.js';
import type { ChatActivity, ChatControls, ChatImage, ChatMessageView } from './chat.js';
import { Log } from '../core/timed-log.js';

const log = new Log('ChatWindow');
const CHAT_WINDOW_INTERFACE: InterfaceId = 'abjects:chat-window';

const DEFAULT_WIN_W = 640;
const DEFAULT_WIN_H = 620;

// ── Bubble styling ─────────────────────────────────────────────────────
const BUBBLE_MAX_FRACTION = 0.75;
const BUBBLE_MIN_WIDTH = 240;
const SENDER_LABEL_HEIGHT = 18;
// Static welcome-card body copy; shared by creation and resize reflow so the
// height estimate never diverges between the two paths.
const WELCOME_BODY_TEXT = 'Abjects is a distributed object system where everything is an Abject: autonomous objects that communicate via messages, discover each other through a Registry, and coordinate work through goals and agents.\n\nAsk me to explore what objects exist, create new ones, fetch your email, or anything else \u2014 specialized agents pick up the work automatically.';
const GROUP_WINDOW_MS = 3 * 60_000;

// ── Composer ───────────────────────────────────────────────────────────
const SEND_GLYPH = '\u27A4';       // ➤
const ATTACH_GLYPH = '📎'; // 📎
// Two ASCII pipes, not U+2016 DOUBLE VERTICAL LINE — the canvas font renders
// that glyph as a single stroke, which reads as anything but "pause".
const PAUSE_GLYPH = '||';          // pause the running goal
const RESUME_GLYPH = '\u25B6';     // ▶ resume the paused goal
const STOP_GLYPH = '\u25A0';       // ■ stop the goal entirely
const SEND_BTN_SIZE = 44;
const INPUT_MIN_HEIGHT = 44;
const COMPOSER_HINT_DEFAULT = '\u21B5  Send   \u00B7   \u21E7\u21B5  Newline';
const COMPOSER_HINT_GOAL = `\u21B5  Queue a note for the goal   \u00B7   ${PAUSE_GLYPH}  Pause   \u00B7   ${STOP_GLYPH}  Stop`;
const COMPOSER_HINT_PAUSED = `\u21B5  Send note   \u00B7   ${RESUME_GLYPH}  Resume   \u00B7   ${STOP_GLYPH}  Stop`;
const COMPOSER_HINT_CLARIFY = `\u21B5  Answer to continue the goal   \u00B7   ${STOP_GLYPH}  Stop`;

// ── Status strip + eye ─────────────────────────────────────────────────
/** Height of the status strip above the message log. */
const STATUS_STRIP_H = 18;
const CHAT_EYE_PREFIX = 'chat-eye';
const CHAT_EYE_SIZE = 18;
/** Motes per second rising off the eye while the chat is working. */
const CHAT_STREAM_RATE = 6;
/** Leading mark on the activity header (the kit's sigil ring). */
const THINKING_TEXT = '\u25C9 Thinking\u2026';

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
  /** Last layout height applied from the bubble's contentHeight report. */
  h?: number;
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


interface ChatWindowArgs {
  chatId: AbjectId;
  conversationId?: string;
  title?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

const NO_CONTROLS: ChatControls = { turnBusy: false, goalActive: false, paused: false, clarifying: false };

export class ChatWindow extends Abject {
  /** The conversation this window shows. */
  private readonly chatId: AbjectId;
  private conversationId?: string;
  private conversationTitle?: string;
  private initialRect?: { x: number; y: number; width: number; height: number };
  private widgetManagerId?: AbjectId;

  // Window/widget IDs
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private messageLogId?: AbjectId;
  private textInputId?: AbjectId;
  private sendBtnId?: AbjectId;
  private uploadBtnId?: AbjectId;
  /** Status strip above the log: "Ready" when idle, phosphor while working. */
  private statusStripId?: AbjectId;
  /** Eye sigil shown in the status strip while the chat is working. */
  private eyeShown = false;
  /** Rate the eye's thinking stream was last given (0 = resting or no eye). */
  private streamRate = 0;
  /** Stop button shown next to Send while a goal is in progress. */
  private stopBtnId?: AbjectId;
  private composerHintLabelId?: AbjectId;
  private composerRowId?: AbjectId;
  private composerColumnId?: AbjectId;

  /** What the composer can do, as Chat last said. */
  private controls: ChatControls = { ...NO_CONTROLS };
  /** Whether the goal controls (pause/resume + stop) are up. */
  private goalControlsShown = false;
  /** Chat is working (a turn, or a goal it owns). */
  private working = false;

  private messageLabelIds: AbjectId[] = [];
  /** Messages already drawn, by Chat's message id (the transcript and live events overlap). */
  private shownMessageIds = new Set<string>();

  /** Current content width of the window (updated on resize). */
  private currentWindowWidth = DEFAULT_WIN_W;
  private currentRect?: { x: number; y: number; width: number; height: number };

  /** Per-message metadata (role/sender/timestamp) keyed by label AbjectId. */
  private messageMetadata = new Map<AbjectId, MessageMeta>();
  /** bubble label id → its preceding sender header label id (if any). */
  private bubbleSenderLabels = new Map<AbjectId, AbjectId>();
  /** Pending debounced resize-reflow timer. */
  private reflowTimer?: ReturnType<typeof setTimeout>;

  /** Consolidated "Thinking / activity" bubble shown while Chat works. */
  private activityBubbleLabelId?: AbjectId;
  /** Embedded goal-progress widget shown beneath the activity header. */
  private activityGoalWidgetId?: AbjectId;
  private activityGoalHeight = 0;
  /** Goals the user folded in the inline progress tree (open by default). */
  private collapsedGoals = new Set<string>();
  /** The live activity as Chat last sent it. */
  private activity?: ChatActivity;

  /** Welcome-card widget ids (destroyed on first message / clear). */
  private welcomeWidgetIds: AbjectId[] = [];

  /**
   * Images pasted into the composer (the input emitted their bytes via an
   * `attach` event), sent with the next message.
   */
  private pendingImages: ChatImage[] = [];

  /**
   * Drawing happens one step at a time, in the order Chat's events arrived.
   * Handlers run concurrently, and a bubble that is still being built must
   * not let the next one land above it.
   */
  private renderChain: Promise<void> = Promise.resolve();

  constructor(args: ChatWindowArgs) {
    super({
      manifest: {
        name: 'ChatWindow',
        description: 'The desktop window of one Chat conversation: draws its messages, live activity and composer, and passes what the person types to the Chat.',
        version: '1.0.0',
        interface: {
          id: CHAT_WINDOW_INTERFACE,
          name: 'ChatWindow',
          description: 'A view of a Chat conversation',
          methods: [
            { name: 'show', description: 'Open the window (or raise it).', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'raise', description: 'Bring the open window to the front.', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
            { name: 'close', description: 'Close the window.', parameters: [], returns: { kind: 'primitive', primitive: 'boolean' } },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.UI_SURFACE, reason: 'Display the chat window', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'ui'],
      },
    });
    precondition(typeof args?.chatId === 'string' && args.chatId.length > 0, 'ChatWindow needs the Chat it shows');
    this.chatId = args.chatId;
    this.conversationId = args.conversationId;
    this.conversationTitle = args.title;
    this.initialRect = args.rect;
    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(!this.goalControlsShown || !!this.windowId, 'ChatWindow: goal controls without a window');
    invariant(!this.activityGoalWidgetId || !!this.activityBubbleLabelId, 'ChatWindow: a goal tree without its activity bubble');
  }

  /** Queue one drawing step behind the ones already queued. */
  private render(step: () => Promise<void>): Promise<void> {
    const next = this.renderChain.then(step).catch((err) => {
      log.warn(`render step failed: ${err instanceof Error ? err.message : String(err)}`);
    });
    this.renderChain = next;
    return next;
  }

  private setupHandlers(): void {
    this.on('show', async () => {
      if (this.windowId) { await this.raise(); return true; }
      await this.render(() => this.open());
      return !!this.windowId;
    });

    this.on('raise', async () => this.raise());

    this.on('close', async () => {
      await this.render(() => this.closeWindow());
      return true;
    });

    // The Chat this window shows has stopped (its conversation was deleted).
    this.on('chatGone', async (msg: AbjectMessage) => {
      if (msg.routing.from !== this.chatId) return;
      await this.render(() => this.closeWindow());
      const factoryId = await this.discoverDep('Factory');
      if (factoryId) this.send(request(this.id, factoryId, 'kill', { objectId: this.id }));
    });

    // ── From Chat ──────────────────────────────────────────────────────

    this.on('chatActivity', (msg: AbjectMessage) => {
      if (msg.routing.from !== this.chatId) return;
      const snapshot = msg.payload as ChatActivity;
      void this.render(() => this.applyActivity(snapshot));
    });

    this.on('chatControls', (msg: AbjectMessage) => {
      if (msg.routing.from !== this.chatId) return;
      const controls = msg.payload as ChatControls;
      void this.render(() => this.applyControls(controls));
    });

    this.on('chatEffect', (msg: AbjectMessage) => {
      if (msg.routing.from !== this.chatId) return;
      const { effect, color } = msg.payload as { effect: string; color?: string };
      this.playEffect(effect, color);
    });

    this.on('chatCleared', (msg: AbjectMessage) => {
      if (msg.routing.from !== this.chatId) return;
      void this.render(async () => {
        this.shownMessageIds.clear();
        await this.clearMessageLabels();
        await this.showWelcomeState();
      });
    });

    // ── From the window ────────────────────────────────────────────────

    // The close button: the conversation goes on, the window goes away.
    this.on('windowCloseRequested', async () => {
      this.send(event(this.id, this.chatId, 'windowClosed', {}));
    });

    // A file picked or dropped onto the window (UIServer → WindowAbject →
    // WidgetManager → us): the Chat stores and attaches it.
    this.on('fileUploaded', async (msg: AbjectMessage) => {
      try {
        await this.request(request(this.id, this.chatId, 'fileUploaded', msg.payload), 60_000);
      } catch (err) {
        log.warn(`upload hand-off failed: ${err instanceof Error ? err.message : String(err)}`);
        this.playEffect('shake');
      }
      return true;
    });

    // The text input keeps focus but doesn't consume PageUp/PageDown, so the
    // window bubbles them here. Forward to the message log so the conversation
    // scrolls a page at a time without reaching for the mouse.
    this.on('keyUnhandled', async (msg: AbjectMessage) => {
      const { key } = msg.payload as { key?: string };
      if (!this.messageLogId) return;
      if (key === 'PageUp' || key === 'PageDown' || key === 'Home' || key === 'End') {
        try {
          await this.request(request(this.id, this.messageLogId, 'scrollKey', { key }));
        } catch { /* log gone */ }
      }
    });

    this.on('windowResized', async (msg: AbjectMessage) => {
      const { width, height } = msg.payload as { width: number; height: number };
      if (typeof width === 'number' && width > 0 && width !== this.currentWindowWidth) {
        this.currentWindowWidth = width;
        this.scheduleReflow();
      }
      if (this.currentRect) {
        if (typeof width === 'number' && width > 0) this.currentRect.width = width;
        if (typeof height === 'number' && height > 0) this.currentRect.height = height;
        this.reportRect();
      }
      // Keep the eye anchored to the status strip's right end.
      if (this.eyeShown) {
        await this.sendEyeOps([{ op: 'update', id: `${CHAT_EYE_PREFIX}-sigil`, transform: { position: this.eyePosition() } }]);
      }
    });

    this.on('windowMoved', async (msg: AbjectMessage) => {
      const { x, y } = msg.payload as { x: number; y: number };
      if (this.currentRect) {
        if (typeof x === 'number') this.currentRect.x = x;
        if (typeof y === 'number') this.currentRect.y = y;
        this.reportRect();
      }
    });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      // The conversation, from Chat.
      if (fromId === this.chatId) {
        if (aspect === 'messageAdded') {
          const m = value as ChatMessageView;
          void this.render(() => this.drawMessage(m));
        } else if (aspect === 'titleChanged') {
          const { title } = value as { title: string };
          this.conversationTitle = title;
          this.refreshWindowTitle();
        } else if (aspect === 'goalActivity') {
          const { active } = value as { active: boolean };
          void this.render(() => this.applyWorking(!!active));
        }
        return;
      }

      if (fromId === this.sendBtnId && aspect === 'click') {
        // While a goal runs, the send button is the Pause/Resume control.
        if (this.goalControlsShown) {
          await this.handlePauseResumeClick();
          return;
        }
        await this.handleSendClick();
        return;
      }

      if (fromId === this.stopBtnId && aspect === 'click') {
        await this.handleStopClick();
        return;
      }

      if (fromId === this.textInputId && aspect === 'submit') {
        await this.handleSendClick();
        return;
      }

      // The composer references a pasted image inline (data: URI) and handed us
      // its bytes; remember them so the next send stores + attaches for the LLM.
      if (fromId === this.textInputId && aspect === 'attach') {
        const a = value as { name: string; mimeType: string; base64: string } | undefined;
        if (a?.base64) this.pendingImages.push({ name: a.name, mimeType: a.mimeType, base64: a.base64 });
        return;
      }

      if (fromId === this.uploadBtnId && aspect === 'click') {
        if (this.windowId) this.send(request(this.id, this.windowId, 'openFilePicker', { multiple: true }));
        return;
      }

      // Welcome suggestion chips: clicking a chip sends the chip's prompt.
      if (aspect === 'click' && this.welcomeWidgetIds.includes(fromId)) {
        const chipText = value as string | undefined;
        const prompt = chipText ? this.promptForChipText(chipText) : undefined;
        if (prompt && !this.controls.turnBusy && !this.controls.goalActive) {
          await this.sendToChat({ message: prompt });
        }
        return;
      }

      if (fromId === this.textInputId && aspect === 'resize') {
        const { preferredHeight } = (msg.payload as { aspect: string; value: { preferredHeight: number } }).value;
        // The composer is nested three deep: input → composerRow → composerColumn
        // → root VBox. Each layout sizes its child by the child's preferredSize,
        // so the height must be pushed down all three levels or an inner fixed
        // height caps the input.
        try {
          await this.request(request(this.id, this.composerRowId!, 'updateLayoutChild', {
            widgetId: this.textInputId,
            preferredSize: { height: preferredHeight },
          }));
          await this.request(request(this.id, this.composerColumnId!, 'updateLayoutChild', {
            widgetId: this.composerRowId,
            preferredSize: { height: preferredHeight },
          }));
          const columnHeight = preferredHeight + this.theme.tokens.space.xs + this.theme.tokens.space.xl;
          await this.request(request(this.id, this.rootLayoutId!, 'updateLayoutChild', {
            widgetId: this.composerColumnId,
            preferredSize: { height: columnHeight },
          }));
        } catch { /* layout may be gone */ }
        return;
      }

      // The inline goal tree's arrow (and status mark) fold a goal's tasks
      // away and back, as in the Goals window.
      if (aspect === 'toggle' && fromId === this.activityGoalWidgetId) {
        try {
          const { id } = JSON.parse(value as string) as { id?: string };
          if (id) {
            if (this.collapsedGoals.has(id)) this.collapsedGoals.delete(id);
            else this.collapsedGoals.add(id);
            void this.render(() => this.refreshActivityBubble());
          }
        } catch { /* malformed toggle */ }
        return;
      }

      // Self-sizing log children (contentBlock bubbles, embedded goal widget)
      // report their natural height; resize their log slot so content grows to
      // fit and the message log scrolls (no inner scrollbar, no estimation).
      if (aspect === 'contentHeight') {
        const h = typeof value === 'number' ? value : Number(value);
        if (!Number.isFinite(h)) return;
        if (fromId === this.activityGoalWidgetId) {
          if (Math.abs(h - this.activityGoalHeight) >= 1) {
            this.activityGoalHeight = h;
            await this.setLabelHeight(fromId, h);
          }
          return;
        }
        const meta = this.messageMetadata.get(fromId);
        if (meta) {
          // Breathing room around the text inside the bubble background.
          const padded = h + this.theme.tokens.space.md;
          if (meta.h === undefined || Math.abs(padded - meta.h) >= 1) {
            meta.h = padded;
            await this.setLabelHeight(fromId, padded);
          }
        }
        return;
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Open / close
  // ═══════════════════════════════════════════════════════════════════

  private async raise(): Promise<boolean> {
    if (!this.windowId) return false;
    try {
      await this.request(request(this.id, this.widgetManagerId!, 'raiseWindow', { windowId: this.windowId }));
    } catch { /* best effort */ }
    return true;
  }

  private async open(): Promise<void> {
    if (this.windowId) return;
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

    // Status strip: a quiet "Ready" while idle, phosphor while the chat is
    // thinking or a goal is running (the eye sigil sits at its right end).
    const { widgetIds: [statusStripId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [{
          type: 'label', windowId: this.windowId, text: this.statusStripText(),
          style: this.statusStripStyle(),
        }],
      })
    );
    this.statusStripId = statusStripId;
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChild', {
      widgetId: this.statusStripId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: STATUS_STRIP_H },
    }));

    // Scrollable VBox for message log (expanding, auto-scroll to follow new messages).
    // A bottom margin keeps the last bubble clear of the composer instead of
    // sitting flush against it (which clipped the final line).
    this.messageLogId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        autoScroll: true,
        margins: { top: 0, right: 0, bottom: this.theme.tokens.space.md, left: 0 },
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

    // Input row (HBox: attach + TextInput + Send button).
    this.composerRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.composerColumnId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: this.theme.tokens.space.md,
      })
    );

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
            placeholder: 'Message the agent…',
            wordWrap: true, maxLines: 6,
            // Keep the comfortable empty height as the auto-grow floor so the
            // composer doesn't shrink the moment the first character is typed.
            minHeight: INPUT_MIN_HEIGHT,
            // Markdown render mode: pasted images show inline in the composer
            // while editing stays plain-text.
            style: { markdown: true },
          },
          {
            // Secondary: a plain square button beside the input.
            type: 'button', windowId: this.windowId, text: ATTACH_GLYPH,
            style: {
              color: this.theme.textSecondary,
              fontSize: 18,
            },
          },
          {
            // The one primary action: a solid red Send block.
            type: 'button', windowId: this.windowId, text: SEND_GLYPH,
            style: {
              background: this.theme.actionBg,
              color: this.theme.actionText,
              borderColor: this.theme.actionBorder,
              fontSize: 18,
              fontWeight: 'bold',
            },
          },
          {
            type: 'label', windowId: this.windowId,
            text: COMPOSER_HINT_DEFAULT,
            style: {
              color: this.theme.textMeta,
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
    this.uploadBtnId = widgetIds[1];
    this.sendBtnId = widgetIds[2];
    this.composerHintLabelId = widgetIds[3];

    // Add attach button + input + send button to the composer row. The buttons
    // are fixed-size and bottom-aligned (alignment 'right' = bottom on the HBox
    // cross-axis) so they stay pinned to the bottom as the input grows taller;
    // the input expands to fill the row height.
    await this.request(request(this.id, this.composerRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.uploadBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: SEND_BTN_SIZE, height: SEND_BTN_SIZE }, alignment: 'right' as const },
        { widgetId: this.textInputId, sizePolicy: { horizontal: 'expanding' }, preferredSize: { height: INPUT_MIN_HEIGHT } },
        { widgetId: this.sendBtnId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' }, preferredSize: { width: SEND_BTN_SIZE, height: SEND_BTN_SIZE }, alignment: 'right' as const },
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
    this.send(request(this.id, this.uploadBtnId, 'addDependent', {}));
    this.send(request(this.id, this.textInputId, 'addDependent', {}));

    // The conversation: subscribe first, then read what is already there, so
    // nothing said in between is lost (a message in both is drawn once).
    await this.request(request(this.id, this.chatId, 'addDependent', {}));
    const transcript = await this.request<{
      title?: string; messages: ChatMessageView[]; controls: ChatControls; activity: ChatActivity; working: boolean;
    }>(request(this.id, this.chatId, 'getTranscript', {}));
    if (transcript.title) {
      this.conversationTitle = transcript.title;
      this.refreshWindowTitle();
    }
    log.info(`[ChatWindow ${(this.conversationId ?? this.chatId).slice(0, 8)}] open: ${transcript.messages.length} message(s)`);
    if (transcript.messages.length === 0) {
      await this.showWelcomeState();
    } else {
      for (const m of transcript.messages) await this.drawMessage(m);
    }
    await this.applyWorking(transcript.working);
    await this.applyControls(transcript.controls);
    await this.applyActivity(transcript.activity);
    this.checkInvariants();
  }

  private async closeWindow(): Promise<void> {
    if (!this.windowId) return;
    const windowId = this.windowId;
    try { this.send(request(this.id, this.chatId, 'removeDependent', {})); } catch { /* chat gone */ }
    try {
      await this.request(request(this.id, this.widgetManagerId!, 'destroyWindowAbject', { windowId }));
    } catch { /* already gone */ }
    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.messageLogId = undefined;
    this.composerRowId = undefined;
    this.composerColumnId = undefined;
    this.composerHintLabelId = undefined;
    this.textInputId = undefined;
    this.sendBtnId = undefined;
    this.uploadBtnId = undefined;
    this.statusStripId = undefined;
    this.eyeShown = false;
    this.streamRate = 0;
    this.stopBtnId = undefined;
    this.goalControlsShown = false;
    this.messageLabelIds = [];
    this.shownMessageIds.clear();
    this.messageMetadata.clear();
    this.bubbleSenderLabels.clear();
    this.activityBubbleLabelId = undefined;
    this.activityGoalWidgetId = undefined;
    this.activityGoalHeight = 0;
    this.welcomeWidgetIds = [];
    this.pendingImages = [];
    if (this.reflowTimer) {
      this.cancelTimer(this.reflowTimer);
      this.reflowTimer = undefined;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Drawing what Chat says
  // ═══════════════════════════════════════════════════════════════════

  /** Draw one message once, whether it came from the transcript or live. */
  private async drawMessage(m: ChatMessageView): Promise<void> {
    if (!this.windowId || !m || m.role === 'activity') return;
    if (m.id) {
      if (this.shownMessageIds.has(m.id)) return;
      this.shownMessageIds.add(m.id);
    }
    await this.removeWelcomeState();
    await this.appendBubble(m.role, m.sender, m.text, m.markdown);
  }

  /** Chat started or stopped working: status strip, eye, title dot. */
  private async applyWorking(working: boolean): Promise<void> {
    if (working === this.working) return;
    this.working = working;
    this.refreshWindowTitle();
    await this.syncWorkingIndicators();
  }

  /** Bring the composer in line with what Chat says it can do now. */
  private async applyControls(next: ChatControls): Promise<void> {
    const prev = this.controls;
    this.controls = { ...NO_CONTROLS, ...next };
    if (!this.windowId) return;
    if (this.controls.goalActive && !this.goalControlsShown) await this.enterGoalControls();
    if (!this.controls.goalActive && this.goalControlsShown) await this.exitGoalControls();
    if (this.controls.goalActive && this.sendBtnId) {
      const glyph = this.controls.paused ? RESUME_GLYPH : PAUSE_GLYPH;
      try { await this.request(request(this.id, this.sendBtnId, 'update', { text: glyph, style: { disabled: false } })); } catch { /* widget gone */ }
      await this.setComposerHint(this.controls.clarifying ? COMPOSER_HINT_CLARIFY
        : this.controls.paused ? COMPOSER_HINT_PAUSED : COMPOSER_HINT_GOAL);
    }
    // While a routing turn runs (and no goal has taken over) the composer
    // waits; a running goal keeps it live, since a message there is a note.
    const locked = this.controls.turnBusy && !this.controls.goalActive;
    await this.setInputDisabled(locked);
    if (prev.turnBusy !== this.controls.turnBusy && this.sendBtnId) {
      // Long-op accent halo on the send button so the person sees the agent
      // is working even when the activity bubble scrolls off-screen.
      try { this.send(event(this.id, this.sendBtnId, 'update', { busy: this.controls.turnBusy })); } catch { /* widget gone */ }
    }
    if (prev.paused !== this.controls.paused) await this.syncThinkingStream();
  }

  /** Show, update or remove the activity bubble from Chat's snapshot. */
  private async applyActivity(snapshot: ChatActivity): Promise<void> {
    this.activity = snapshot;
    if (!this.windowId) return;
    if (snapshot.active && !this.activityBubbleLabelId) await this.showActivityBubble();
    if (!snapshot.active && this.activityBubbleLabelId) { await this.removeActivityBubble(); return; }
    if (snapshot.active) await this.refreshActivityBubble();
  }

  // ═══════════════════════════════════════════════════════════════════
  // What the person does
  // ═══════════════════════════════════════════════════════════════════

  private async sendToChat(payload: { message: string; images?: ChatImage[] }): Promise<boolean> {
    try {
      const accepted = await this.request<boolean>(request(this.id, this.chatId, 'sendMessage', payload), 60_000);
      if (!accepted) this.playEffect('shake');
      return accepted === true;
    } catch (err) {
      log.warn(`send failed: ${err instanceof Error ? err.message : String(err)}`);
      this.playEffect('shake');
      return false;
    }
  }

  private async handleSendClick(): Promise<void> {
    // While a goal runs (or is paused) the composer is the note channel: Chat
    // takes the message as a note to the goal. During a routing turn with no
    // goal yet, the composer waits.
    const interjecting = this.controls.goalActive;
    if ((this.controls.turnBusy && !interjecting) || !this.textInputId) return;

    const text = await this.request<string>(
      request(this.id, this.textInputId, 'getValue', {})
    );

    // Inline image references in the composer (`![](abject://…)`) become
    // attachments; the remaining typed text is the message. With no text and
    // no pasted images there is nothing to send.
    const cleanText = this.stripImageRefs(text ?? '').trim();
    if (interjecting) {
      if (!cleanText) return;
      await this.request(request(this.id, this.textInputId, 'update', { text: '' }));
      await this.sendToChat({ message: cleanText });
      return;
    }
    if (!cleanText && this.pendingImages.length === 0) return;

    await this.request(request(this.id, this.textInputId, 'update', { text: '' }));
    const images = this.pendingImages;
    this.pendingImages = [];
    await this.sendToChat({ message: cleanText, ...(images.length > 0 ? { images } : {}) });
  }

  /** Remove block image markdown lines (`![alt](url)`), leaving the typed text. */
  private stripImageRefs(text: string): string {
    return text
      .split('\n')
      .filter((line) => !/^\s*!\[[^\]]*\]\([^)]+\)\s*$/.test(line))
      .join('\n');
  }

  private async handlePauseResumeClick(): Promise<void> {
    const method = this.controls.paused ? 'resumeGoal' : 'pauseGoal';
    try {
      await this.request(request(this.id, this.chatId, method, {}), 15_000);
    } catch { this.playEffect('shake'); }
  }

  private async handleStopClick(): Promise<void> {
    try {
      await this.request(request(this.id, this.chatId, 'stopGoal', {}), 15_000);
    } catch { this.playEffect('shake'); }
  }

  /** Tell Chat where the window is, so it reopens there. */
  private reportRect(): void {
    if (!this.currentRect) return;
    try { this.send(event(this.id, this.chatId, 'windowRect', { rect: { ...this.currentRect } })); } catch { /* chat gone */ }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Composer controls
  // ═══════════════════════════════════════════════════════════════════

  private async setInputDisabled(disabled: boolean): Promise<void> {
    const style = { disabled };
    // While goal controls are up, the send button is Pause/Resume and must
    // stay clickable regardless of the text input's lock state.
    if (this.sendBtnId && !this.goalControlsShown) {
      try { await this.request(request(this.id, this.sendBtnId, 'update', { style })); } catch { /* widget gone */ }
    }
    if (this.textInputId) {
      try { await this.request(request(this.id, this.textInputId, 'update', { style })); } catch { /* widget gone */ }
    }
  }

  private async setComposerHint(text: string): Promise<void> {
    if (!this.composerHintLabelId) return;
    try { await this.request(request(this.id, this.composerHintLabelId, 'update', { text })); } catch { /* widget gone */ }
  }

  /**
   * A goal started: the send button becomes Pause and a Stop button joins
   * the composer row. Torn down by exitGoalControls when the goal ends.
   */
  private async enterGoalControls(): Promise<void> {
    if (this.goalControlsShown || !this.windowId || !this.sendBtnId || !this.composerRowId) return;
    this.goalControlsShown = true;
    try {
      await this.request(request(this.id, this.sendBtnId, 'update', { text: PAUSE_GLYPH, style: { disabled: false } }));
      const { widgetIds: [stopBtnId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', { specs: [
          { type: 'button', windowId: this.windowId, text: STOP_GLYPH,
            style: {
              background: this.theme.destructiveBg,
              color: this.theme.destructiveText,
              borderColor: this.theme.destructiveBorder,
              fontSize: 16,
            } },
        ]})
      );
      this.stopBtnId = stopBtnId;
      await this.request(request(this.id, stopBtnId, 'addDependent', {}));
      await this.request(request(this.id, this.composerRowId, 'addLayoutChild', {
        widgetId: stopBtnId,
        sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
        preferredSize: { width: SEND_BTN_SIZE, height: SEND_BTN_SIZE },
        alignment: 'right' as const,
      }));
      await this.setComposerHint(COMPOSER_HINT_GOAL);
      // The composer stays live during the goal: typed text goes to the goal
      // as a note.
      if (this.textInputId) {
        try { await this.request(request(this.id, this.textInputId, 'update', { style: { disabled: false } })); } catch { /* widget gone */ }
      }
    } catch { /* widget gone — controls degrade to plain busy state */ }
  }

  /** Tear the goal controls down and restore the plain composer. */
  private async exitGoalControls(): Promise<void> {
    if (!this.goalControlsShown) return;
    this.goalControlsShown = false;
    if (this.sendBtnId) {
      try { await this.request(request(this.id, this.sendBtnId, 'update', { text: SEND_GLYPH })); } catch { /* widget gone */ }
    }
    if (this.stopBtnId) {
      const stopBtnId = this.stopBtnId;
      this.stopBtnId = undefined;
      if (this.composerRowId) {
        try { await this.request(request(this.id, this.composerRowId, 'removeLayoutChild', { widgetId: stopBtnId })); } catch { /* widget gone */ }
      }
      try { await this.request(request(this.id, stopBtnId, 'destroy', {})); } catch { /* widget gone */ }
    }
    await this.setComposerHint(COMPOSER_HINT_DEFAULT);
  }

  /**
   * Window title: the conversation title, plus a trailing dot while the chat
   * works (the same mark the taskbar's chat row shows).
   */
  private formatWindowTitle(title?: string): string {
    const t = (title ?? this.conversationTitle ?? 'Chat').trim();
    const base = t || 'Chat';
    return this.working ? `${base} ●` : base;
  }

  /** Push the current title (with or without the busy dot) to the window. */
  private refreshWindowTitle(): void {
    if (!this.windowId) return;
    try {
      this.send(request(this.id, this.windowId, 'setTitle', { title: this.formatWindowTitle() }));
    } catch { /* window gone */ }
  }

  // ── Activity bubble (consolidated thinking + progress) ───────────────

  private async showActivityBubble(): Promise<void> {
    if (this.activityBubbleLabelId) return;
    this.activityGoalHeight = 0;
    this.activityBubbleLabelId = await this.appendBubble('activity', 'Agent', this.activity?.header ?? THINKING_TEXT, false);

    // Embed the shared goal-progress widget directly beneath the header so the
    // running goal tree renders identically to the Goals window (word-wrapped,
    // full text) instead of a separate plain-text tree. It sizes itself via a
    // `contentHeight` event and grows to fit; the message log scrolls.
    if (this.messageLogId && this.windowId) {
      const bubbleMaxWidth = this.computeBubbleMaxWidth();
      const { widgetIds: [goalWidgetId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [{ type: 'goalProgress', windowId: this.windowId, rows: [],
            style: { background: 'transparent' } }],
        })
      );
      this.activityGoalWidgetId = goalWidgetId;
      await this.request(request(this.id, this.messageLogId, 'addLayoutChild', {
        widgetId: goalWidgetId,
        sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
        preferredSize: { width: bubbleMaxWidth, height: 0 },
        alignment: 'left',
      }));
      this.messageLabelIds.push(goalWidgetId);
      this.send(request(this.id, goalWidgetId, 'addDependent', {}));
    }
  }

  /** Map Chat's live goal snapshot into the shared row model, scoped to the run. */
  private buildActivityRows() {
    const snapshot = this.activity;
    const goals: GoalNode[] = (snapshot?.goals ?? []).map(g => ({
      id: g.id,
      parentId: g.parentId,
      title: g.title,
      description: g.description ?? '',
      status: g.status,
      latestMessage: g.latestMessage,
      latestAgent: g.latestAgent,
    }));
    return buildGoalRows({
      goals,
      isExpanded: (id) => !this.collapsedGoals.has(id), // open unless folded
      getTasks: (id) => snapshot?.tasks[id] ?? [],
      rootId: snapshot?.rootId,
    });
  }

  private async refreshActivityBubble(): Promise<void> {
    if (!this.activityBubbleLabelId) return;
    const text = this.activity?.header ?? THINKING_TEXT;
    // Keep the cached bubble text in sync (metadata is the durable record).
    const meta = this.messageMetadata.get(this.activityBubbleLabelId);
    if (meta) meta.text = text;
    // The bubble is a contentBlock: it re-measures on the text update and
    // reports the new height itself, so no estimate/threshold cycle here.
    await this.updateLabel(this.activityBubbleLabelId, text, this.theme.statusNeutral);
    // Feed the embedded goal widget the current row model; it reports its own
    // height back via a `contentHeight` event (handled in the changed router).
    if (this.activityGoalWidgetId) {
      const rows = this.buildActivityRows();
      try {
        await this.request(request(this.id, this.activityGoalWidgetId, 'update', { rows }));
      } catch { /* widget may be gone */ }
    }
  }

  private async removeActivityBubble(): Promise<void> {
    if (!this.activityBubbleLabelId) return;
    const id = this.activityBubbleLabelId;
    const goalWidgetId = this.activityGoalWidgetId;
    this.activityBubbleLabelId = undefined;
    this.activityGoalWidgetId = undefined;
    this.activityGoalHeight = 0;
    this.collapsedGoals.clear();
    if (goalWidgetId) await this.detachLabel(goalWidgetId);
    await this.removeLabel(id);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Welcome state
  // ═══════════════════════════════════════════════════════════════════

  private async showWelcomeState(): Promise<void> {
    if (!this.messageLogId || !this.windowId) return;
    if (this.welcomeWidgetIds.length > 0) return;

    const tokens = this.theme.tokens;
    const headingText = sectionHeaderText(this.theme, 'Welcome to Chat');
    const bodyText = WELCOME_BODY_TEXT;

    const { cardWidth, spacerHeight, headingHeight, bodyHeight } = this.welcomeCardLayout();

    const specs: Array<Record<string, unknown>> = [
      // Spacer above the card for vertical breathing room.
      {
        type: 'label', windowId: this.windowId, text: '',
        style: { color: this.theme.textTertiary, fontSize: 1, wordWrap: false, selectable: false },
      },
      // Display-font heading.
      {
        type: 'label', windowId: this.windowId, text: headingText,
        style: {
          color: this.theme.textHeading,
          fontSize: 20,
          fontWeight: 'bold',
          fontFamily: 'display',
          wordWrap: false,
          selectable: false,
          align: 'center' as const,
        },
      },
      // Body description in a ruled card.
      {
        type: 'label', windowId: this.windowId, text: bodyText,
        style: {
          color: this.theme.textSecondary,
          background: this.theme.inputBg,
          borderColor: this.theme.windowBorder,
          radius: tokens.radius.lg,
          fontSize: 13,
          wordWrap: true,
          selectable: false,
          align: 'center' as const,
        },
      },
    ];

    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', { specs })
    );
    const [spacerId, headingId, bodyId] = widgetIds;

    const addCentered = async (id: AbjectId, width: number, height: number) => {
      await this.request(request(this.id, this.messageLogId!, 'addLayoutChild', {
        widgetId: id,
        sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
        preferredSize: { width, height },
        alignment: 'center',
      }));
      this.welcomeWidgetIds.push(id);
      this.messageLabelIds.push(id);
    };

    await addCentered(spacerId, cardWidth, spacerHeight);
    await addCentered(headingId, cardWidth, headingHeight);
    await addCentered(bodyId, cardWidth, bodyHeight);
  }

  /**
   * Shared sizing for the welcome card so creation (showWelcomeState) and
   * resize reflow (updateWelcomeLayout) compute identical geometry.
   */
  private welcomeCardLayout(): {
    cardWidth: number;
    spacerHeight: number;
    headingHeight: number;
    bodyHeight: number;
  } {
    const tokens = this.theme.tokens;
    const cardWidth = Math.min(this.computeBubbleMaxWidth(), 460);
    const innerWidth = cardWidth - tokens.space.lg * 2;
    // Use the markdown estimator (paragraph-aware) + padding so the card never clips.
    const bodyHeight = this.estimateBubbleHeight(WELCOME_BODY_TEXT, innerWidth, true) + tokens.space.xl;
    return { cardWidth, spacerHeight: tokens.space.xl, headingHeight: 30, bodyHeight };
  }

  /**
   * Re-fit the welcome card widgets in place for the current window size.
   * updateLayoutChild merges the new preferredSize into the existing layout
   * entry, so the three labels keep their ids and content — no destroy/recreate
   * cycle, hence no blank frame while replacements render (resize flash).
   */
  private async updateWelcomeLayout(): Promise<void> {
    if (!this.messageLogId || !this.windowId) return;
    if (this.welcomeWidgetIds.length === 0) return;

    const { cardWidth, spacerHeight, headingHeight, bodyHeight } = this.welcomeCardLayout();
    const heights = [spacerHeight, headingHeight, bodyHeight];
    const updates: Promise<unknown>[] = [];
    for (let i = 0; i < this.welcomeWidgetIds.length; i++) {
      const id = this.welcomeWidgetIds[i];
      const height = heights[i] ?? bodyHeight;
      updates.push(
        this.request(request(this.id, this.messageLogId!, 'updateLayoutChild', {
          widgetId: id,
          sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
          preferredSize: { width: cardWidth, height },
          alignment: 'center',
        }))
      );
    }
    await Promise.all(updates);
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
    // Chip labels are rendered with a leading "›  " glyph; match on the label.
    const chip = DEFAULT_SUGGESTIONS.find(c => chipText === c.label || chipText.endsWith(c.label));
    return chip?.prompt;
  }

  // ── Status strip + eye ────────────────────────────────────────────────

  private statusStripText(): string {
    return this.working ? `\u25C9  ${chromeCase(this.theme, 'Working')}` : chromeCase(this.theme, 'Ready');
  }

  private statusStripStyle(): Record<string, unknown> {
    const base = { fontSize: 11, fontFamily: 'display', wordWrap: false, selectable: false };
    return this.working
      ? { ...base, ...livingStyle(this.theme, 11), fontWeight: 'bold' }
      : { ...base, color: this.theme.textMeta, fontWeight: 'normal' };
  }

  /** Eye position: right end of the status strip, px from the window centre. */
  private eyePosition(): [number, number, number] {
    const w = this.currentRect?.width ?? this.currentWindowWidth;
    const h = this.currentRect?.height ?? DEFAULT_WIN_H;
    const sp = this.theme.tokens.space;
    // Content starts 36px below the window top; the strip follows the top margin.
    return [w / 2 - sp.lg - CHAT_EYE_SIZE / 2 - 4, -h / 2 + 36 + sp.md + STATUS_STRIP_H / 2, 6];
  }

  /**
   * Bring the status strip and the eye sigil in line with the busy state.
   * Runs only on transitions (and once per show); one label update and one
   * scene batch each, all eye motion is client-side.
   */
  private async syncWorkingIndicators(): Promise<void> {
    if (!this.windowId) return;
    if (this.statusStripId) {
      try {
        this.send(event(this.id, this.statusStripId, 'update', {
          text: this.statusStripText(), style: this.statusStripStyle(),
        }));
      } catch { /* widget gone */ }
    }
    const want = this.working;
    if (want === this.eyeShown) return;
    this.eyeShown = want;
    // The eye opens with its thinking stream (resting while a goal is
    // paused); removing the sigil takes the stream with it.
    this.streamRate = want ? this.wantedStreamRate() : 0;
    await this.sendEyeOps(want
      ? [
        ...eyeSigilOps(CHAT_EYE_PREFIX, this.eyePosition(), CHAT_EYE_SIZE),
        ...sigilStreamOps(CHAT_EYE_PREFIX, CHAT_EYE_SIZE, this.streamRate),
      ]
      : removeSigilOps(CHAT_EYE_PREFIX));
  }

  /** The stream flows while the eye is open and the work is not paused. */
  private wantedStreamRate(): number {
    return this.eyeShown && !this.controls.paused ? CHAT_STREAM_RATE : 0;
  }

  /** Start or rest the eye's thinking stream on pause/resume transitions. */
  private async syncThinkingStream(): Promise<void> {
    if (!this.windowId || !this.eyeShown) return;
    const rate = this.wantedStreamRate();
    if (rate === this.streamRate) return;
    this.streamRate = rate;
    await this.sendEyeOps([{ op: 'update', id: `${CHAT_EYE_PREFIX}-stream`, params: { rate } }]);
  }

  /** Play a one-shot slab effect on the chat window (visual only). */
  private playEffect(effect: string, color?: string): void {
    if (!this.windowId) return;
    try {
      this.playWindowEffect(this.windowId, effect, color);
    } catch { /* window gone */ }
  }

  private async sendEyeOps(ops: SceneOp[]): Promise<void> {
    if (!this.windowId) return;
    try {
      await this.request(request(this.id, this.windowId, 'scene', { ops }));
    } catch (err) {
      log.warn('Failed to update the chat eye sigil:', err);
    }
  }

  // ── Bubble styling ───────────────────────────────────────────────────

  /**
   * Flat print blocks: the user's own messages ruled in red (the human
   * hand), the agent's ruled in bone, errors in red ink, and activity lines
   * muted with a phosphor rule (the Other at work). Corners follow the
   * theme radius.
   */
  private bubbleStyleForRole(role: BubbleRole): { background: string; color: string; align: BubbleAlign; borderColor?: string } {
    const t = this.theme;
    switch (role) {
      case 'user':
        return { background: t.inputBg, color: t.textPrimary, align: 'right', borderColor: t.accent };
      case 'assistant':
        return { background: t.windowBg, color: t.textPrimary, align: 'left', borderColor: t.windowBorder };
      case 'system':
        return { background: t.progressTrack, color: t.textSecondary, align: 'center' };
      case 'error':
        return { background: t.inputBg, color: t.statusError, align: 'left', borderColor: t.statusError };
      case 'activity':
        return { background: t.windowBg, color: t.textSecondary, align: 'left', borderColor: t.accentSecondary };
    }
  }

  /**
   * Sender line above a bubble: chrome-cased name and time. The user's line
   * carries a red mark, the agent's a sigil ring; others stay muted.
   */
  private senderHeader(role: BubbleRole, sender: string, ts: number): { text: string; color: string; bold: boolean } {
    const time = this.formatTimestamp(ts);
    const name = chromeCase(this.theme, sender);
    switch (role) {
      case 'user':
        return { text: `${time}  \u00B7  ${name}  \u25A0`, color: this.theme.accent, bold: true };
      case 'assistant':
        return { text: `\u25C9  ${name}  \u00B7  ${time}`, color: this.theme.textSecondary, bold: true };
      case 'error':
        return { text: `${name}  \u00B7  ${time}`, color: this.theme.statusError, bold: true };
      default:
        return { text: `${name}  \u00B7  ${time}`, color: this.theme.textMeta, bold: false };
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
   * Append a styled "chat bubble" message to the log. The conversation itself
   * lives in Chat; this only draws what Chat announced.
   * Optionally precedes the bubble with a small sender/timestamp label unless
   * grouping with the previous message (same role+sender within GROUP_WINDOW_MS).
   */
  private async appendBubble(
    role: BubbleRole,
    sender: string,
    text: string,
    markdown = false,
  ): Promise<AbjectId> {
    if (!this.messageLogId || !this.windowId) return '' as AbjectId;

    const { background, color, align, borderColor } = this.bubbleStyleForRole(role);
    const bubbleMaxWidth = this.computeBubbleMaxWidth();
    const innerWidth = bubbleMaxWidth - this.theme.tokens.space.xs * 2;
    const bubbleHeight = this.estimateBubbleHeight(text, innerWidth, markdown);

    // Sender/timestamp mini-label (skipped when grouping).
    const shouldEmitSender = !!sender && !this.shouldGroupWithPrevious(role, sender);
    let senderLabelId: AbjectId | undefined;
    if (shouldEmitSender) {
      const header = this.senderHeader(role, sender, Date.now());
      const { widgetIds: [headerId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [
            {
              type: 'label', windowId: this.windowId, text: header.text,
              style: {
                color: header.color,
                fontSize: 11,
                fontFamily: 'display',
                fontWeight: header.bold ? 'bold' : 'normal',
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

    // contentBlock self-measures and reports its real height via a
    // `contentHeight` event (handled in the changed router); the estimate
    // above is only the provisional height for the first frame.
    const { widgetIds: [labelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          {
            type: 'contentBlock', windowId: this.windowId, text,
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
    this.send(request(this.id, labelId, 'addDependent', {}));
    this.messageLabelIds.push(labelId);
    this.messageMetadata.set(labelId, { role, sender, ts: Date.now(), text, markdown, align });
    if (senderLabelId) {
      this.bubbleSenderLabels.set(labelId, senderLabelId);
    }
    return labelId;
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
    this.reflowTimer = this.setTimer(() => {
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
    const updates: Promise<unknown>[] = [];

    for (const labelId of this.messageLabelIds) {
      const meta = this.messageMetadata.get(labelId);
      if (!meta) continue;

      // Width-only update (updateLayoutChild merges preferredSize): the
      // contentBlock re-wraps at the new width and reports its new height via
      // contentHeight, which the changed router applies. No estimation.
      updates.push(
        this.request(request(this.id, this.messageLogId, 'updateLayoutChild', {
          widgetId: labelId,
          sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
          preferredSize: { width: bubbleMaxWidth },
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

    // The embedded goal widget carries no metadata (it is not a text bubble),
    // so it is skipped above. Push the new width explicitly; it re-wraps and
    // re-reports its height via `contentHeight`.
    if (this.activityGoalWidgetId) {
      updates.push(
        this.request(request(this.id, this.messageLogId, 'updateLayoutChild', {
          widgetId: this.activityGoalWidgetId,
          sizePolicy: { vertical: 'fixed', horizontal: 'fixed' },
          preferredSize: { width: bubbleMaxWidth, height: this.activityGoalHeight },
          alignment: 'left',
        })).catch(() => { /* widget gone */ })
      );
    }

    await Promise.all(updates);

    // The welcome card is sized by hand outside the bubble path, so it is
    // re-fit here, in place. Destroying and recreating it made the card vanish
    // from the frame until the replacements finished rendering, a visible
    // flash on every resize.
    await this.updateWelcomeLayout();
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
    this.activityGoalWidgetId = undefined;
    this.activityGoalHeight = 0;
    // Welcome widgets (chips + card) live inside the message log and were
    // just cleared above; drop our tracked ids.
    this.welcomeWidgetIds = [];
  }
}

export const CHAT_WINDOW_ID = 'abjects:chat-window' as AbjectId;
