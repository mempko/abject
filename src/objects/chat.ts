/**
 * Chat — conversational LLM agent.
 *
 * Provides a chat window where users type natural language requests.
 * Registers with AgentAbject as an agent — AgentAbject drives the
 * think-act-observe state machine, calling back Chat for observe and act.
 */

import { AbjectId, AbjectManifest, AbjectMessage, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { formatManifestAsDescription } from '../core/introspect.js';
import type { AgentAction } from './agent-abject.js';
import type { DiscoveredWorkspace } from './workspace-share-registry.js';
import { estimateWrappedLineCount } from './widgets/word-wrap.js';
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
  private userObjectSummaries = '';
  private systemObjectSummaries = '';
  private remotePeerContext = '';
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

    // Register with AgentAbject
    await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'Chat',
      description: 'Conversational LLM agent for interacting with Abjects',
      config: {
        pinnedMessageCount: 1,
        terminalActions: {
          done: { type: 'success', resultFields: ['text', 'result', 'reasoning'] },
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
      this.triggerSend(message.trim());
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
        await this.appendMessageLabel('Agent', 'How can I help you?', this.theme.statusSuccess);
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
        if (this._currentGoalId) {
          const data = value as { goalId: string; message?: string; phase?: string; agentName?: string };
          if (data.goalId !== this._currentGoalId) return;
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
      const lines: string[] = [];
      if (this.userObjectSummaries) {
        lines.push('Your Abjects (user-created — use "modify" to update):');
        lines.push(this.userObjectSummaries);
      }
      if (this.systemObjectSummaries) {
        lines.push('');
        lines.push('System Abjects (built-in):');
        lines.push(this.systemObjectSummaries);
      }
      if (this.remotePeerContext) {
        lines.push('');
        lines.push('Connected peers:');
        lines.push(this.remotePeerContext);
      }
      return { observation: lines.join('\n') || 'No objects available.' };
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
          await this.appendMessageLabel('Agent', text, this.theme.statusSuccess);
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

  private async handleAgentAct(action: AgentAction): Promise<unknown> {
    switch (action.action) {
      case 'list': {
        const objects = await this.request<ObjectRegistration[]>(
          request(this.id, this.registryId!, 'list', {})
        );
        return {
          success: true,
          data: objects.map(o => ({
            name: o.manifest.name,
            description: o.manifest.description,
            id: o.id,
          })),
        };
      }

      case 'introspect': {
        const objectId = await this.resolveObject(action.object as string);
        if (!objectId) return { success: false, error: `Object "${action.object}" not found` };
        const result = await this.request<{ manifest: AbjectManifest; description: string }>(
          request(this.id, objectId, 'describe', {})
        );
        return { success: true, data: result };
      }

      case 'ask': {
        const objectId = await this.resolveObject(action.object as string);
        if (!objectId) return { success: false, error: `Object "${action.object}" not found` };
        const answer = await this.request<string>(
          request(this.id, objectId, 'ask', { question: action.question as string }),
          60000
        );
        return { success: true, data: answer };
      }

      case 'call': {
        const targetStr = action.object as string;
        const objectId = await this.resolveObject(targetStr);
        if (!objectId) return { success: false, error: `Object "${targetStr}" not found` };

        const method = action.method as string;

        // Fire-and-forget for show/hide — no need to wait
        if (method === 'show' || method === 'hide') {
          this.send(event(this.id, objectId, method, action.payload ?? {}));
          return { success: true, data: `${method} sent` };
        }

        // Route runTask calls to WebAgent-like objects through TupleSpace
        if (method === 'runTask' && this.goalManagerId && this._currentGoalId) {
          try {
            const taskPayload = action.payload as { task?: string; options?: Record<string, unknown> } | undefined;
            const { taskId } = await this.request<{ taskId: string }>(
              request(this.id, this.goalManagerId, 'addTask', {
                goalId: this._currentGoalId,
                type: 'browse',
                description: taskPayload?.task ?? 'Web task',
                data: taskPayload?.options,
              })
            );
            const completion = await this.waitForTaskCompletion(taskId, 310000);
            return { success: true, data: completion.result };
          } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
          }
        }

        const timeout = method === 'runTask' || method === 'create' ? 310000 : 120000;
        try {
          const result = await this.request(
            request(this.id, objectId, method, action.payload ?? {}),
            timeout,
          );
          return { success: true, data: result };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'create': {
        // Route through TupleSpace — agents claim autonomously
        if (this.goalManagerId && this._currentGoalId) {
          try {
            log.info(`[Chat] create action — adding task to TupleSpace, goalId=${this._currentGoalId.slice(0, 8)}`);
            const { taskId } = await this.request<{ taskId: string }>(
              request(this.id, this.goalManagerId, 'addTask', {
                goalId: this._currentGoalId,
                type: 'create',
                description: action.description as string,
              })
            );
            log.info(`[Chat] create task added: ${taskId.slice(0, 8)}, waiting for completion...`);
            const completion = await this.waitForTaskCompletion(taskId, 310000);
            const result = completion.result as { success?: boolean; error?: string; objectId?: AbjectId } | undefined;
            if (result && result.success === false) {
              return { success: false, error: result.error ?? 'Create failed' };
            }
            // Auto-show created object
            const objectId = result?.objectId;
            if (objectId) {
              this.send(event(this.id, objectId, 'show', {}));
            }
            return { success: true, data: result };
          } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
          }
        }

        // Fallback: direct call if GoalManager unavailable
        const creatorId = await this.discoverDep('ObjectCreator');
        if (!creatorId) return { success: false, error: 'ObjectCreator not found' };
        try {
          const result = await this.request(
            request(this.id, creatorId, 'create', {
              prompt: action.description as string,
              goalId: this._currentGoalId,
            }),
            310000,
          );
          const payload = result as { success?: boolean; error?: string; objectId?: AbjectId };
          if (payload && payload.success === false) {
            return { success: false, error: payload.error ?? 'Create failed' };
          }
          const objectId = payload?.objectId;
          if (objectId) {
            this.send(event(this.id, objectId, 'show', {}));
          }
          return { success: true, data: result };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'modify': {
        const objectId = await this.resolveObject(action.object as string);
        if (!objectId) return { success: false, error: `Object "${action.object}" not found` };

        // Route through TupleSpace — agents claim autonomously
        if (this.goalManagerId && this._currentGoalId) {
          try {
            const { taskId } = await this.request<{ taskId: string }>(
              request(this.id, this.goalManagerId, 'addTask', {
                goalId: this._currentGoalId,
                type: 'modify',
                description: action.description as string,
                data: { objectId },
              })
            );
            const completion = await this.waitForTaskCompletion(taskId, 310000);
            const result = completion.result as { success?: boolean; error?: string } | undefined;
            if (result && result.success === false) {
              return { success: false, error: result.error ?? 'Modify failed' };
            }
            return { success: true, data: result };
          } catch (err) {
            return { success: false, error: err instanceof Error ? err.message : String(err) };
          }
        }

        // Fallback: direct call if GoalManager unavailable
        const creatorId = await this.discoverDep('ObjectCreator');
        if (!creatorId) return { success: false, error: 'ObjectCreator not found' };
        try {
          const result = await this.request(
            request(this.id, creatorId, 'modify', {
              objectId,
              prompt: action.description as string,
              goalId: this._currentGoalId,
            }),
            310000,
          );
          const modPayload = result as { success?: boolean; error?: string };
          if (modPayload && modPayload.success === false) {
            return { success: false, error: modPayload.error ?? 'Modify failed' };
          }
          return { success: true, data: result };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'clone': {
        // Clone a clonable object (local or remote) — Factory searches all registries
        const qualifiedName = action.object as string;
        if (!qualifiedName) return { success: false, error: 'Missing object name or qualified name (peer.workspace.ObjectName)' };

        try {
          // Resolve qualified name to an AbjectId via remote registry listing
          const parts = qualifiedName.split('.');
          let objectId: AbjectId | null = null;
          let objectName = qualifiedName;

          if (parts.length >= 3) {
            // Qualified name: peer.workspace.ObjectName
            const peerName = parts[0];
            const wsName = parts[1];
            objectName = parts.slice(2).join('.');

            const wsrId = await this.discoverDep('WorkspaceShareRegistry');
            if (!wsrId) return { success: false, error: 'WorkspaceShareRegistry not found' };

            const workspaces = await this.request<DiscoveredWorkspace[]>(
              request(this.id, wsrId, 'getDiscoveredWorkspaces', {})
            );
            const ws = workspaces.find(w => w.ownerName === peerName && w.name === wsName);
            if (!ws) return { success: false, error: `Workspace "${peerName}.${wsName}" not found in discovered workspaces` };

            const remoteObjects = await this.request<ObjectRegistration[]>(
              request(this.id, ws.registryId as AbjectId, 'list', {})
            );
            const target = remoteObjects.find(o => (o.name ?? o.manifest.name) === objectName);
            if (!target) return { success: false, error: `Object "${objectName}" not found in ${peerName}.${wsName}` };
            objectId = target.id;
          } else {
            // Simple name or AbjectId — resolve locally
            objectId = await this.resolveObject(qualifiedName);
          }

          if (!objectId) return { success: false, error: `Object "${qualifiedName}" not found` };

          // Factory.clone searches local then remote registries automatically
          const factoryId = await this.requireDep('Factory');
          const result = await this.request<{ objectId: AbjectId }>(
            request(this.id, factoryId, 'clone', { objectId, registryHint: this.registryId })
          );

          // Persist to AbjectStore so it survives reload
          try {
            const storeResults = await this.request<Array<{ id: AbjectId }>>(
              request(this.id, this.registryId!, 'discover', { name: 'AbjectStore' })
            );
            if (storeResults.length > 0) {
              // Look up the freshly cloned object's registration for manifest/source
              const reg = await this.request<ObjectRegistration | null>(
                request(this.id, this.registryId!, 'lookup', { objectId: result.objectId })
              );
              if (reg?.source) {
                await this.request(request(this.id, storeResults[0].id, 'save', {
                  objectId: result.objectId,
                  manifest: reg.manifest,
                  source: reg.source,
                  owner: this.id,
                }));
              }
            }
          } catch { /* AbjectStore may not exist */ }

          return { success: true, data: { clonedObjectId: result.objectId, name: objectName } };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'delegate': {
        // Delegate a task to another registered agent via ticket pattern
        try {
          const agents = await this.request<Array<{ agentId: AbjectId; name: string }>>(
            request(this.id, this.agentAbjectId!, 'listAgents', {})
          );
          const agent = agents.find(a => a.name === action.agent);
          if (!agent) return { success: false, error: `Agent "${action.agent}" not found` };
          const { ticketId } = await this.request<{ ticketId: string }>(
            request(this.id, this.agentAbjectId!, 'startTask', {
              agentId: agent.agentId,
              task: action.task as string,
              responseSchema: action.responseSchema as Record<string, unknown> | undefined,
            }),
          );
          this._currentTicketId = ticketId;
          const result = await this.waitForTaskResult(ticketId, 310000);
          this._currentTicketId = undefined;
          return { success: true, data: result };
        } catch (err) {
          this._currentTicketId = undefined;
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      default:
        return { success: false, error: `Unknown action: ${action.action}` };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // System prompt
  // ═══════════════════════════════════════════════════════════════════

  private buildSystemPrompt(): string {
    return `You are Chat Agent, a helpful assistant inside the Abjects system. You help users by interacting with objects via structured actions.

## System Architecture

Abjects is a distributed message-passing system. Each Abject is an autonomous object with a manifest (declaring methods and events), a mailbox, and message handlers. Objects communicate exclusively via messages — never direct calls. They discover each other via Registry and coordinate via the observer pattern (addDependent → changed events).

### Three UI Patterns

1. **Widget Objects** (forms, settings, dashboards): Standard UI controls — buttons, text inputs, labels, sliders, checkboxes, tabs, progress bars, images. Use WidgetManager to create windows with widget layouts.
2. **Canvas Surface Objects** (games, charts, custom graphics): Raw drawing via WidgetManager.createCanvas — shapes, text, images, gradients, transforms. Timer-driven animation.
3. **Web Automation** (interact with real websites): WebAgent drives a headless browser to navigate, fill forms, click, and extract data from real sites.

### When to Create vs Modify vs Call

- Use **create** when the user wants a brand-new object with its own window and behavior (e.g., "make me a todo app", "build a color picker"). ObjectCreator will design and generate it.
- Use **modify** when the user wants to **fix, change, or update** an existing object's behavior or appearance (e.g., "add a reset button to the counter", "fix the login button", "change the background color"). Always prefer modify over create when the object already exists.
- Use **call** to invoke existing objects directly (e.g., "fetch this URL", "set a timer", "run this web task"). Use **ask** first to learn the object's API.
- Use **ask** on any object to get usage guidance with code examples. This is how you discover APIs — don't guess method signatures.

### Observer & Composition Model

Objects observe each other via addDependent → changed events. Any object can inspect another via getState, describe, or ask. Objects with show/hide methods automatically appear in the Taskbar.

## Action Format

Respond with ONE action as a JSON object in a \`\`\`json code block. Include brief reasoning before the block.

\`\`\`json
{ "action": "done", "text": "Hello! How can I help you?" }
\`\`\`

## Available Actions

### Information
- **list**: List available objects. No params.
  \`{ "action": "list" }\`
- **introspect**: Get an object's manifest and description.
  \`{ "action": "introspect", "object": "ObjectName" }\`
- **ask**: Ask an object for usage advice.
  \`{ "action": "ask", "object": "ObjectName", "question": "How do I use your X method?" }\`

### Object Interaction
- **call**: Send a message to an object (message passing).
  \`{ "action": "call", "object": "ObjectName", "method": "methodName", "payload": { ... } }\`
  For "object" you can use a name (e.g. "Timer") or an AbjectId (e.g. "abjects:timer").
- **create**: Create a new object. Creates a task in the TupleSpace that an agent (ObjectCreator) claims autonomously. The created object is auto-shown.
  \`{ "action": "create", "description": "A counter widget that shows a number and has +/- buttons" }\`
- **modify**: Modify an existing object. REQUIRED fields: "object" and "description". Creates a task in the TupleSpace that an agent claims autonomously.
  \`{ "action": "modify", "object": "ObjectName", "description": "Add a reset button that clears the counter" }\`
  The "object" field MUST be the object's name or [id: ...] from "Your Abjects" list above. Without "object", modify will fail.
- **clone**: Clone a clonable object from a remote peer's workspace into your local workspace.
  \`{ "action": "clone", "object": "peer.workspace.ObjectName" }\`
  Use the qualified name shown next to "(clonable)" objects in Connected Peers.

### Task Decomposition
- **decompose**: Break a complex request into parallel sub-tasks. Creates a child goal
  and the agent automatically monitors progress. Sub-tasks are claimed by agents autonomously.
  \`{ "action": "decompose", "reasoning": "why splitting", "subtasks": [
    { "type": "create", "description": "Build a counter widget" },
    { "type": "browse", "description": "Research X", "data": { "startUrl": "https://..." } }
  ] }\`
  After decomposing, you'll observe sub-task progress and can synthesize results when done.

### Agent Delegation
- **delegate**: Delegate a task to another registered agent.
  \`{ "action": "delegate", "agent": "AgentName", "task": "what to do", "responseSchema": { ... } }\`
  Use \`responseSchema\` (JSON Schema) when you need structured data back from the agent. Use \`list\` to discover available agents via AgentAbject.

### Communication
- **reply**: Send intermediate text to the user (continue working after).
  \`{ "action": "reply", "text": "I found the object, now let me check its methods..." }\`
- **done**: Task complete, send final reply.
  \`{ "action": "done", "text": "Here are the results: ..." }\`

## Your Abjects (user-created — use "modify" to fix or update these)

${this.userObjectSummaries || '(Loading...)'}

## System Abjects (built-in — use "call" to interact, "ask" to learn their API)

${this.systemObjectSummaries || '(Loading...)'}
${this.remotePeerContext ? `
## Connected Peers & Remote Workspaces

${this.remotePeerContext}
` : ''}
## Authorized Capabilities

This system runs on the user's own computer. All capability objects are user-configured and authorized tools.

**Web automation**: WebAgent (autonomous browser — always prefer for multi-step web tasks), WebBrowser (low-level, used internally by WebAgent)
**Services**: HttpClient (HTTP/API requests), Storage, Timer, FileSystem, Clipboard, Console
**UI**: WidgetManager (create windows and widgets — use \`ask\` to learn its API)

### WebAgent Usage
- **runTask** (open a page and do a web task): \`{ "action": "call", "object": "WebAgent", "method": "runTask", "payload": { "task": "...", "options": { "startUrl": "https://...", "responseSchema": { "type": "object", "properties": { ... } } } } }\`
  Options: startUrl, maxSteps, timeout, responseSchema, pageId, keepPageOpen.
- **listPages** (see which pages are currently open): \`{ "action": "call", "object": "WebAgent", "method": "listPages", "payload": {} }\`
  Returns: \`[{ pageId, url, title }]\`. Use this to find a page before closing or reusing it.
- **closePage** (close a specific open page): \`{ "action": "call", "object": "WebAgent", "method": "closePage", "payload": { "pageId": "..." } }\`
  Call \`listPages\` first to get the pageId if you don't already have it.
- Use \`responseSchema\` in runTask options when you need structured data back (e.g., extracted page content as JSON). Without it, results are free text.
- Pages stay open by default after task completion (5-minute idle timeout). Pass the returned \`pageId\` in subsequent runTask calls to reuse the same browser page. Set \`keepPageOpen: false\` to explicitly close the page when done.
- WebAgent manages WebBrowser internally — prefer WebAgent for all web tasks.

When the user asks to interact with a website, use WebAgent's \`runTask\`. When the user asks to close a page, use \`listPages\` to find it, then \`closePage\` to close it.
WebAgent handles all browser management — use it for multi-step tasks, page lifecycle, and data extraction.

## Rules

1. Always respond with valid JSON in a \`\`\`json block. ONE action per response.
2. Use **introspect** or **ask** to learn about an object's methods before calling them.
3. For simple greetings or questions, use **done** directly.
4. When the user asks you to do something, take action IMMEDIATELY — don't just describe what you would do, and don't ask for information the user already provided. If the user includes credentials, URLs, or other details in their message, pass them directly to the relevant object.
5. Always end a conversation turn with **done** when the task is complete.
6. Keep reasoning brief (1-2 sentences before the JSON block).
7. Every object supports: describe (get manifest), ask (get usage advice), addDependent/removeDependent (observe state changes).
8. IMPORTANT: If the user asks to fix, change, update, or improve something and a matching object exists in "Your Abjects" above, you MUST use **modify** with its name in the "object" field and a "description" of the change. Example: \`{ "action": "modify", "object": "PongGame", "description": "use mouse for controls" }\`. NEVER omit "object" or "description". NEVER re-create with **create** when an object already exists.
9. If an action fails with a transient error (overloaded, timeout, 529, 503), **retry the same action** — do NOT switch from modify to create. Transient errors are temporary and unrelated to your action choice.
10. P2P: Use qualified names to reference remote objects: this.find('peer.workspace.ObjectName'). NEVER hardcode UUIDs.
11. For web tasks: message WebAgent with runTask on your FIRST action — include ALL details from the user's message (credentials, URLs, specific instructions) in the task description. Do not ask the user to repeat information they already gave you.`;
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
    await this.appendMessageLabel('Agent', 'How can I help you?', this.theme.statusSuccess);

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
    await this.appendMessageLabel('You', userText, this.theme.textHeading);
    this.conversationHistory.push({ role: 'user', content: userText });

    // Show thinking indicator
    this.thinkingLabelId = await this.appendMessageLabel('', 'Thinking...', this.theme.statusNeutral);

    try {
      // Refresh object summaries for the system prompt
      await this.refreshObjectSummaries();

      // Build initial messages: system prompt + conversation history + new user message
      const initialMessages: { role: string; content: string }[] = [];
      const recent = this.conversationHistory.slice(-MAX_CONVERSATION_ENTRIES);
      for (const entry of recent) {
        initialMessages.push({ role: entry.role, content: entry.content });
      }

      // Create a goal for this task
      let goalId: string | undefined;
      if (this.goalManagerId) {
        try {
          const goalResult = await this.request<{ goalId: string }>(
            request(this.id, this.goalManagerId, 'createGoal', {
              title: userText.slice(0, 100),
            })
          );
          goalId = goalResult.goalId;
          this._currentGoalId = goalId;
        } catch { /* GoalManager may not be ready */ }
      }

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
            await this.appendMessageLabel('Agent', text, this.theme.statusSuccess);
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

  private async refreshObjectSummaries(): Promise<void> {
    if (this.userObjectSummaries && this.conversationHistory.length < 5) return;

    try {
      const objects = await this.request<ObjectRegistration[]>(
        request(this.id, this.registryId!, 'list', {})
      );

      const userObjects = objects.filter(obj => !(obj.manifest.tags ?? []).includes('system'));
      const systemObjects = objects.filter(obj => (obj.manifest.tags ?? []).includes('system'));

      this.userObjectSummaries = userObjects.length > 0
        ? userObjects.map(obj => `[id: ${obj.id}]\n${formatManifestAsDescription(obj.manifest)}`).join('\n\n---\n\n')
        : '(None yet — use **create** to build something new)';

      this.systemObjectSummaries = systemObjects
        .map(obj => `- ${obj.manifest.name} — ${obj.manifest.description}`)
        .join('\n');
    } catch {
      // Keep existing summaries if refresh fails
    }

    await this.refreshRemotePeerContext();
  }

  private async refreshRemotePeerContext(): Promise<void> {
    try {
      const wsrId = await this.discoverDep('WorkspaceShareRegistry');
      if (!wsrId) return;

      let workspaces = await this.request<DiscoveredWorkspace[]>(
        request(this.id, wsrId, 'getDiscoveredWorkspaces', {})
      );

      if (workspaces.length === 0) {
        workspaces = await this.request<DiscoveredWorkspace[]>(
          request(this.id, wsrId, 'discoverWorkspaces', { hops: 1 })
        );
      }

      if (workspaces.length === 0) {
        this.remotePeerContext = '';
        return;
      }

      const lines: string[] = [];
      for (const ws of workspaces) {
        try {
          const remoteObjects = await this.request<ObjectRegistration[]>(
            request(this.id, ws.registryId as AbjectId, 'list', {})
          );
          const objNames = remoteObjects.map(o => {
            const clonable = (o as ObjectRegistration & { source?: string }).source ? ' (clonable)' : '';
            const displayName = o.name ?? o.manifest.name;
            const qualified = `${ws.ownerName}.${ws.name}.${displayName}`;
            return `${displayName} → find('${qualified}')${clonable}`;
          }).join(', ');
          lines.push(`- Peer "${ws.ownerName}" workspace "${ws.name}" (registryId: ${ws.registryId})\n  Objects: ${objNames}`);
        } catch {
          lines.push(`- Peer "${ws.ownerName}" workspace "${ws.name}" (registryId: ${ws.registryId})\n  Objects: (could not query)`);
        }
      }
      this.remotePeerContext = lines.join('\n');
      if (lines.length > 0) {
        this.remotePeerContext += "\n\nGenerated code should use this.find('peer.workspace.ObjectName') — never hardcode UUIDs. To copy a clonable object locally, use the clone action.";
      }
    } catch {
      // Best-effort — leave remotePeerContext unchanged
    }
  }

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

  private async appendMessageLabel(prefix: string, text: string, color: string): Promise<AbjectId> {
    if (!this.messageLogId || !this.windowId) return '' as AbjectId;

    const displayText = prefix ? `${prefix}: ${text}` : text;
    const fontSize = 13;
    const lineHeight = fontSize + 4;
    const availableWidth = WIN_W - 32 - 8; // margins + scrollbar
    const lineCount = estimateWrappedLineCount(displayText, availableWidth, fontSize);
    const estimatedHeight = Math.max(20, lineCount * lineHeight + 4);

    const { widgetIds: [labelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'label', windowId: this.windowId, text: displayText, style: { color, fontSize, wordWrap: true, selectable: true } },
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

  protected override getSourceForAsk(): string | undefined {
    return `## Chat Usage Guide

### Send a message programmatically

  await call(await dep('Chat'), 'sendMessage', { message: 'Hello, what can you do?' });
  // The Chat agent processes the message through its observe-think-act loop

### Show / hide the Chat window

  await call(await dep('Chat'), 'show', {});
  await call(await dep('Chat'), 'hide', {});

### Get current state

  const state = await call(await dep('Chat'), 'getState', {});
  // state: { phase, messageCount, visible, currentGoalId }

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
