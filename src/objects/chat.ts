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
import { Log } from '../core/timed-log.js';

const log = new Log('Chat');
const CHAT_INTERFACE: InterfaceId = 'abjects:chat';

const WIN_W = 500;
const WIN_H = 500;
const MAX_CONVERSATION_ENTRIES = 40;
const MAX_STEPS = 20;

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

export class Chat extends Abject {
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;
  private agentAbjectId?: AbjectId;

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

  /** Label ID for the current "Thinking..." indicator. */
  private thinkingLabelId?: AbjectId;

  /** Label IDs for progress lines appended during the current task. */
  private progressLabelIds: AbjectId[] = [];

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

  constructor() {
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
                name: 'clearHistory',
                description: 'Reset conversation history',
                parameters: [],
                returns: { kind: 'primitive', primitive: 'boolean' },
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

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.registryId = await this.requireDep('Registry');
    this.agentAbjectId = await this.requireDep('AgentAbject');
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;

    // Subscribe to GoalManager for real-time goal updates
    if (this.goalManagerId) {
      this.send(request(this.id, this.goalManagerId, 'addDependent', {}));
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

    this.on('addNotification', async (msg: AbjectMessage) => {
      const { sender, message } = msg.payload as { sender: string; message: string };
      if (!message?.trim()) return false;
      log.info(`[Chat] addNotification from "${sender}": "${message.trim().slice(0, 80)}"`);
      await this.appendMessageLabel(sender || 'System', message.trim(), this.theme.statusNeutral, true);
      this.conversationHistory.push({ role: 'assistant', content: `[${sender}]: ${message.trim()}` });
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
      if (this.windowId) {
        await this.clearMessageLabels();
        await this.appendMessageLabel('Agent', 'How can I help you?', this.theme.statusSuccess, true);
      }
      return true;
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });

    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect } = msg.payload as { aspect: string; value?: unknown };
      const fromId = msg.routing.from;

      if (fromId === this.sendBtnId && aspect === 'click') {
        await this.handleSendClick();
        return;
      }

      if (fromId === this.textInputId && aspect === 'submit') {
        await this.handleSendClick();
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
          return;
        }
        // taskRetrying — task will be re-dispatched, don't reject the promise
        if (aspect === 'taskRetrying') {
          const data = value as { taskId: string; attempts?: number; maxAttempts?: number; error?: string };
          log.info(`[Chat] GoalManager taskRetrying ${data.taskId.slice(0, 8)} attempts=${data.attempts ?? '?'}/${data.maxAttempts ?? '?'} — NOT rejecting promise`);
          return;
        }

        // Goal progress events — append progress labels for sub-agent updates.
        // Skip Chat's own updates (agentName === 'Chat') since agentPhaseChanged already covers those.
        // Accept progress from the current goal AND its child goals (parentId match).
        if (this._currentGoalId) {
          const data = value as { goalId: string; parentId?: string; message?: string; phase?: string; agentName?: string };
          const isCurrentGoal = data.goalId === this._currentGoalId;
          const isChildGoal = data.parentId === this._currentGoalId;
          if (!isCurrentGoal && !isChildGoal) return;
          if (aspect === 'goalUpdated') {
            // Any goal progress resets ALL pending timeouts
            this.resetTaskCompletionTimeouts();
            this.resetPendingTicketTimeouts();
            if (data.message && data.agentName && data.agentName !== 'Chat') {
              await this.appendProgressLabel(`  ${data.agentName}: ${data.message}`);
            }
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

      const { ticketId, step, maxSteps, phase, action } =
        msg.payload as { ticketId: string; step: number; maxSteps: number; phase: string; action?: string };
      if (!this._currentTicketId) return;
      if (ticketId && ticketId !== this._currentTicketId) return;

      // Update thinking label with progress
      if (this.thinkingLabelId) {
        if (phase === 'thinking') {
          this.updateLabel(this.thinkingLabelId, `Thinking... (step ${step + 1}/${maxSteps})`, this.theme.statusNeutral);
        } else if (phase === 'observing') {
          this.updateLabel(this.thinkingLabelId, `Observing... (step ${step + 1}/${maxSteps})`, this.theme.statusNeutral);
        }
      }
    });

    this.on('taskStream', async (msg: AbjectMessage) => {
      const { ticketId, content } =
        msg.payload as { ticketId: string; content: string; done: boolean };
      if (!this._currentTicketId) return;
      if (ticketId && ticketId !== this._currentTicketId) return;
      this._streamBuffer += content;
    });

    this.on('progress', async (msg: AbjectMessage) => {
      // Reset pending ticket + task completion timeouts on any progress signal
      this.resetPendingTicketTimeouts();
      this.resetTaskCompletionTimeouts();
      const { message } = msg.payload as { phase?: string; message?: string };
      if (!this._currentTicketId || !this.thinkingLabelId || !message) return;
      this.updateLabel(this.thinkingLabelId, `  ${message}`, this.theme.statusNeutral);
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

      if (this.thinkingLabelId) {
        if (newPhase === 'thinking') {
          this.updateLabel(this.thinkingLabelId, `Thinking... (step ${step + 1})`, this.theme.statusNeutral);
        } else if (newPhase === 'acting' && action) {
          await this.appendProgressLabel(`  ▸ ${action}...`);
        }
      }
    });

    this.on('agentIntermediateAction', async (msg: AbjectMessage) => {
      const { action } = msg.payload as { taskId: string; action: AgentAction };

      // Handle 'reply' intermediate action — show text in UI, clear thinking label
      if (action.action === 'reply') {
        const text = (action.text as string) ?? '';
        if (text && this.thinkingLabelId) {
          await this.removeLabel(this.thinkingLabelId);
          await this.appendMessageLabel('Agent', text, this.theme.statusSuccess, true);
          this.thinkingLabelId = undefined;
          // Re-show thinking indicator for next step
          this.thinkingLabelId = await this.appendMessageLabel('', 'Thinking...', this.theme.statusNeutral);
        }
      }

    });

    this.on('agentActionResult', async (msg: AbjectMessage) => {
      const { action, result } =
        msg.payload as { taskId: string; action: AgentAction; result: { success: boolean; error?: string } };

      if (this.thinkingLabelId) {
        const desc = action?.reasoning ?? action?.action ?? '';
        if (result.success) {
          await this.appendProgressLabel(`  ✓ ${desc}`);
        } else {
          await this.appendProgressLabel(`  ✗ ${desc}`);
        }
      }
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
      const tasks = (action.tasks as Array<{ description: string; data?: Record<string, unknown>; dependsOn?: number[] }>) ?? [];
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
        // Add all tasks to the goal, mapping index-based dependsOn to taskIds
        const taskIds: string[] = [];
        for (const task of tasks) {
          const depIds = (task.dependsOn ?? [])
            .filter(idx => idx >= 0 && idx < taskIds.length)
            .map(idx => taskIds[idx]);

          const { taskId } = await this.request<{ taskId: string }>(
            request(this.id, this.goalManagerId, 'addTask', {
              goalId,
              description: task.description,
              data: task.data,
              dependsOn: depIds.length > 0 ? depIds : undefined,
            })
          );
          taskIds.push(taskId);
        }

        // Wait for all tasks to complete
        const results: unknown[] = [];
        for (const taskId of taskIds) {
          const completion = await this.waitForTaskCompletion(taskId, 310000);
          const result = completion.result as Record<string, unknown> | undefined;

          // Auto-show created objects
          if (result?.objectId) {
            this.send(event(this.id, result.objectId as AbjectId, 'show', {}));
          }
          results.push(result);
        }

        const failures = results.filter(r => r && (r as Record<string, unknown>).success === false);
        if (failures.length > 0) {
          const errors = failures.map(f => (f as Record<string, unknown>).error ?? 'Unknown error');
          return { success: false, error: errors.join('; '), data: results };
        }
        return { success: true, data: results.length === 1 ? results[0] : results };
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
    return `You are Chat Agent, a helpful assistant inside the Abjects system. You help users by creating goals and routing tasks to specialized agents.

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
  Complex request (multiple parallel tasks):
  \`{ "action": "goal", "title": "Weather dashboard", "tasks": [
    { "description": "Fetch current weather data for Miami, FL using an HTTP API" },
    { "description": "Create a new dashboard widget that displays temperature and humidity" }
  ] }\`
  Sequential tasks (task 1 depends on task 0):
  \`{ "action": "goal", "title": "Fetch and summarize", "tasks": [
    { "description": "Fetch the latest news headlines" },
    { "description": "Summarize the fetched headlines into a brief report", "dependsOn": [0] }
  ] }\`
  Use dependsOn with 0-based task indices when a task needs a previous task to finish first. Tasks without dependsOn run in parallel.
  Include the object name in the task description when relevant. Be specific about the desired outcome.

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
- **done**: Task complete, send final reply. The user can only see what you put in the done text, so include the complete results from previous actions. Present all data fully, do not summarize or truncate.
  \`{ "action": "done", "text": "Here are the results: ..." }\`

The chat window renders markdown. Use **bold**, *italic*, \`inline code\`, headings, bullet lists, code blocks, and [links](url) in your reply and done text for readable formatting.

## Writing Good Task Descriptions

Task descriptions are how agents decide whether they can handle a task. Describe WHAT needs to happen, not HOW to do it. Agents already know their own tools, APIs, credentials, and connection details. Including implementation details (ports, protocols, libraries, connection strings) in task descriptions confuses agent routing.
- Include the object name when the task involves an existing object (e.g., "Modify the HackerNews object to..." not just "Fix the UI")
- Describe the desired outcome, not just the problem (e.g., "Add a reset button to the Counter that sets the count back to zero")
- For web tasks, mention that it involves a real website (e.g., "Browse https://example.com and extract the article text")
- For new functionality, describe what it should do without dictating how (e.g., "Display a todo list with add, remove, and mark-complete functionality")
- When the user says "agent", preserve that word in the task description. An agent is an autonomous entity that registers with the system and can handle tasks on its own. Prefer "Create an agent that..." over "Create an object that..."
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

1. Always respond with valid JSON in a \`\`\`json block. ONE action per response.
2. For simple greetings, use **done** directly. For questions about objects or the system, create a **goal** to investigate rather than guessing. You do not have knowledge of what objects exist or what they can do. Always use the system to find out.
3. When the user asks you to do something, create a **goal** immediately with well-described tasks.
4. Always end a conversation turn with **done** when the task is complete.
5. Keep reasoning brief (1-2 sentences before the JSON block).
6. If a goal's tasks fail, you can retry by creating a new goal with a simpler task description. If it fails repeatedly, use "done" to tell the user what happened.
7. P2P: Resolve remote objects by qualified name: this.find('peer.workspace.ObjectName'). Always use find() for dynamic ID resolution.
8. When the user reveals personal facts (where they live, their name, preferences, job, etc.), save them using **remember** so you can recall them in future conversations.
9. Task descriptions should describe the desired outcome and timing, letting agents decide implementation. Example: "Post a weather briefing to chat every day at 10:30 AM" is better than "Use setInterval to check the time every minute".`;
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

    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: '\uD83D\uDCAC Chat Agent',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 6,
      })
    );

    // Scrollable VBox for message log (expanding, auto-scroll to follow new messages)
    this.messageLogId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        autoScroll: true,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );

    // Input row (HBox: TextInput + Send button)
    this.inputRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );

    // Add layouts to root
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.messageLogId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.inputRowId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' }, preferredSize: { height: 36 } },
      ],
    }));

    // Batch create text input + send button
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'textInput', windowId: this.windowId, placeholder: 'Type a message...', wordWrap: true, maxLines: 6 },
          { type: 'button', windowId: this.windowId, text: 'Send', style: { background: this.theme.actionBg, color: this.theme.actionText, borderColor: this.theme.actionBorder } },
        ],
      })
    );
    this.textInputId = widgetIds[0];
    this.sendBtnId = widgetIds[1];

    // Batch add to input row
    await this.request(request(this.id, this.inputRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.textInputId, sizePolicy: { horizontal: 'expanding' }, preferredSize: { height: 36 } },
        { widgetId: this.sendBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 60, height: 36 } },
      ],
    }));

    // Fire-and-forget: register as dependent of interactive widgets
    this.send(request(this.id, this.sendBtnId, 'addDependent', {}));
    this.send(request(this.id, this.textInputId, 'addDependent', {}));

    this.uiPhase = 'idle';

    // Show greeting
    await this.appendMessageLabel('Agent', 'How can I help you?', this.theme.statusSuccess, true);

    this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    this.uiPhase = 'closed';

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
        windowId: this.windowId,
      })
    );

    this.windowId = undefined;
    this.rootLayoutId = undefined;
    this.messageLogId = undefined;
    this.inputRowId = undefined;
    this.textInputId = undefined;
    this.sendBtnId = undefined;
    this.messageLabelIds = [];
    this.progressLabelIds = [];
    this.changed('visibility', false);
    return true;
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

    // Show user message
    await this.appendMessageLabel('You', userText, this.theme.textHeading, true);
    this.conversationHistory.push({ role: 'user', content: userText });

    // Show thinking indicator
    this.thinkingLabelId = await this.appendMessageLabel('', 'Thinking...', this.theme.statusNeutral);

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
      const result = await this.waitForTaskResult(ticketId, 310000);
      this._currentTicketId = undefined;
      this._currentGoalId = undefined;

      // Post-task UI cleanup
      if (this.thinkingLabelId) {
        if (result.success) {
          await this.removeLabel(this.thinkingLabelId);
          const text = (result.result as string) ?? '';
          if (text) {
            await this.appendMessageLabel('Agent', text, this.theme.statusSuccess, true);
            this.conversationHistory.push({ role: 'assistant', content: text });
          }
        } else {
          await this.removeLabel(this.thinkingLabelId);
          const errorText = (result.error ?? 'Unknown error').slice(0, 100);
          const note = result.maxStepsReached ? ' (step limit reached)' : '';
          await this.appendMessageLabel('Error', errorText + note, this.theme.statusError);
        }
        this.thinkingLabelId = undefined;
      }
      this.progressLabelIds = [];
    } catch (err) {
      this._currentTicketId = undefined;
      this._currentGoalId = undefined;
      // Remove thinking indicator if still there
      if (this.thinkingLabelId) {
        await this.removeLabel(this.thinkingLabelId);
        this.thinkingLabelId = undefined;
      }
      this.progressLabelIds = [];
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.appendMessageLabel('Error', errMsg.slice(0, 100), this.theme.statusError);
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

  private async appendMessageLabel(prefix: string, text: string, color: string, markdown = false): Promise<AbjectId> {
    if (!this.messageLogId || !this.windowId) return '' as AbjectId;

    const fontSize = 13;
    const lineHeight = fontSize + 4;
    const availableWidth = WIN_W - 32 - 8; // margins + scrollbar

    // For markdown labels, emit the prefix as a separate bold label so the
    // markdown body parses correctly (headings, bullets, etc. need to start at
    // column 0). For plain labels, combine prefix and text as before.
    if (markdown && prefix) {
      const prefixText = `${prefix}:`;
      const prefixHeight = Math.max(20, lineHeight + 4);
      const { widgetIds: [prefixLabelId] } = await this.request<{ widgetIds: AbjectId[] }>(
        request(this.id, this.widgetManagerId!, 'create', {
          specs: [
            { type: 'label', windowId: this.windowId, text: prefixText, style: { color, fontSize, fontWeight: 'bold' as const, wordWrap: false, selectable: false } },
          ],
        })
      );
      await this.request(request(this.id, this.messageLogId, 'addLayoutChild', {
        widgetId: prefixLabelId,
        sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: prefixHeight },
      }));
      this.messageLabelIds.push(prefixLabelId);
    }

    const displayText = (!markdown && prefix) ? `${prefix}: ${text}` : text;
    const estimatedHeight = markdown
      ? estimateMarkdownHeight(displayText, availableWidth, fontSize)
      : Math.max(20, estimateWrappedLineCount(displayText, availableWidth, fontSize) * lineHeight + 4);

    const { widgetIds: [labelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'label', windowId: this.windowId, text: displayText, style: { color, fontSize, wordWrap: true, selectable: true, markdown } },
        ],
      })
    );
    await this.request(request(this.id, this.messageLogId, 'addLayoutChild', {
      widgetId: labelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: estimatedHeight },
    }));
    this.messageLabelIds.push(labelId);
    return labelId;
  }

  private async appendProgressLabel(text: string): Promise<void> {
    if (!this.messageLogId || !this.windowId) return;

    // Move thinking label to the bottom so progress lines appear above it.
    // Remove → append progress → re-add thinking label at end.
    if (this.thinkingLabelId) {
      try {
        await this.request(request(this.id, this.messageLogId, 'removeLayoutChild', {
          widgetId: this.thinkingLabelId,
        }));
      } catch { /* may already be gone */ }
    }

    const labelId = await this.appendMessageLabel('', text, this.theme.statusNeutral);
    this.progressLabelIds.push(labelId);

    // Re-add thinking label at the bottom
    if (this.thinkingLabelId) {
      try {
        await this.request(request(this.id, this.messageLogId, 'addLayoutChild', {
          widgetId: this.thinkingLabelId,
          sizePolicy: { vertical: 'fixed' },
          preferredSize: { height: 24 },
        }));
      } catch { /* may already be gone */ }
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
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Chat Usage Guide

### Send a message programmatically

  await call(await dep('Chat'), 'sendMessage', { message: 'Hello, what can you do?' });
  // The Chat agent processes the message through its observe-think-act loop

### Show / hide the Chat window

  await call(await dep('Chat'), 'show', {});
  await call(await dep('Chat'), 'hide', {});

### Get current state

  const state = await call(await dep('Chat'), 'getState', {});
  // state: { phase, messageCount, visible, currentGoalId }

### Display a notification (no agent loop)

  await call(await dep('Chat'), 'addNotification', {
    sender: 'WeatherScheduler',
    message: 'Daily briefing: 62F, partly cloudy in Silverdale WA.'
  });
  // Displays the message in the chat window without triggering the agent loop.
  // Supports markdown. Use this for status updates, results, or alerts from other objects.

### Clear conversation history

  await call(await dep('Chat'), 'clearHistory', {});

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
- Chat is an agent — it uses AgentAbject's observe-think-act loop to process messages.
- sendMessage triggers the full agent cycle: the LLM decides what actions to take.
- Actions can include creating objects, calling other services, or replying with text.
- getState returns currentGoalId when Chat is actively processing a message (null otherwise).
- Chat can receive tasks via LLM semantic fallback even for task types it doesn't explicitly declare.`;
  }
}

export const CHAT_ID = 'abjects:chat' as AbjectId;
