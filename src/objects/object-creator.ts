/**
 * Object Creator - user-facing object for creating and modifying objects via natural language.
 *
 * Uses a multi-phase pipeline:
 *   Phase 0:  askRegistryForDependencies() — Registry ask protocol selects deps
 *   Phase 0c: fetchFullManifests()       — registry.lookup() for selected objects
 *   Phase 0c5: generateTargetedQuestions() — LLM generates goal-specific questions per dep
 *   Phase 0d: fetchUsageGuides()         — ask each dep with targeted (or generic) questions
 *   Phase 1:  generateManifest()         — LLM designs manifest with full dependency context
 *   Phase 2:  generateHandlerCode()      — LLM generates this.call() code
 *   Phase 3:  verifyAndFix()             — programmatic consistency check
 *   Phase 3b: llmVerifyAndFix()          — optional LLM-assisted fix
 *   Phase 4:  compile check
 *   Phase 5:  factory.spawn()
 *   Phase 5b: probeObject()              — validate deps referenced in source resolve
 *   Phase 5c: retryWithProbeFeedback()   — re-select deps, regenerate code, apply fix (up to 2 retries)
 *   Phase 6:  negotiator.connect()       — optional, connects to deps
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  InterfaceId,
  ObjectRegistration,
  SpawnRequest,
  SpawnResult,
} from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { require } from '../core/contracts.js';
import { request, event } from '../core/message.js';
import { IntrospectResult } from '../core/introspect.js';

import { ScriptableAbject } from './scriptable-abject.js';
import { systemMessage, userMessage, userMessageWithImages, LLMMessage, LLMCompletionResult, LLMCompletionOptions } from '../llm/provider.js';
import type { AgentAction } from './agent-abject.js';
import { Log } from '../core/timed-log.js';
import { parseHandlerMap } from './widgets/handler-parser.js';
import { applyHandlerDiff, parseDiffResponse, validateDiff } from './handler-diff.js';

const log = new Log('OBJECT-CREATOR');

/** Methods auto-provided by Abject/ScriptableAbject framework. User code should not implement these. */
const FRAMEWORK_PROVIDED_METHODS = ScriptableAbject.PROTECTED_HANDLERS;

/** Per-creation-task state for tracking agent-driven creation. */
interface CreationTaskExtra {
  prompt: string;
  context?: string;
  callerId?: AbjectId;
  deferredMsg: AbjectMessage;
  result?: CreationResult;
  goalId?: string;
}


const OBJECT_CREATOR_INTERFACE = 'abjects:object-creator' as InterfaceId;

export interface CreateObjectRequest {
  prompt: string;
  context?: string;
}

export interface ModifyObjectRequest {
  objectId: AbjectId;
  prompt: string;
}

export interface CreationResult {
  success: boolean;
  objectId?: AbjectId;
  manifest?: AbjectManifest;
  code?: string;
  error?: string;
  usedObjects?: string[];
}

/** Summary of a registered object (name + description only). */
interface ObjectSummary {
  id: AbjectId;
  name: string;
  description: string;
}

/** A dependency selected by the LLM, with its full manifest and description. */
interface SelectedDependency {
  id: AbjectId;
  name: string;
  manifest: AbjectManifest;
  description: string;
}

/**
 * The Object Creator allows users to create objects via natural language prompts.
 */
export class ObjectCreator extends Abject {
  private llmId?: AbjectId;
  private registryId?: AbjectId;
  private systemRegistryId?: AbjectId;
  private factoryId?: AbjectId;
  private negotiatorId?: AbjectId;
  private abjectStoreId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private agentAbjectId?: AbjectId;
  private _currentCallerId?: AbjectId;
  private _currentGoalId?: string;
  private goalManagerId?: AbjectId;
  private screenshotId?: AbjectId;
  private creationTasks = new Map<string, CreationTaskExtra>();

  /** Pending ticket promises: ticketId → resolve/reject + resettable timer. */
  private pendingTickets = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; timeoutMs: number }>();

  /** Maps inner agent ticketId → caller AbjectId for forwarding stream/progress events. */
  private ticketToCallerId = new Map<string, AbjectId>();

  /** Active LLM request message ID for resetting request timeouts on progress keepalives. */
  private _currentLlmMsgId?: string;

  constructor() {
    super({
      manifest: {
        name: 'ObjectCreator',
        description:
          'Create and modify Abjects using natural language. Discovers existing Abjects and generates new ones that compose with them.',
        version: '1.0.0',
        interface: {
            id: OBJECT_CREATOR_INTERFACE,
            name: 'ObjectCreator',
            description: 'Abject creation via natural language',
            methods: [
              {
                name: 'create',
                description: 'Create a new object from a description',
                parameters: [
                  {
                    name: 'prompt',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Natural language description of the object',
                  },
                  {
                    name: 'context',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Additional context',
                    optional: true,
                  },
                ],
                returns: { kind: 'reference', reference: 'CreationResult' },
              },
              {
                name: 'modify',
                description: 'Modify an existing object',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Object to modify',
                  },
                  {
                    name: 'prompt',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'What to change',
                  },
                ],
                returns: { kind: 'reference', reference: 'CreationResult' },
              },
              {
                name: 'suggest',
                description: 'Get suggestions for objects to create',
                parameters: [
                  {
                    name: 'context',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'What the user wants to achieve',
                  },
                ],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'primitive', primitive: 'string' },
                },
              },
              {
                name: 'listAvailable',
                description: 'List available objects for composition',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'ObjectRegistration' },
                },
              },
              {
                name: 'executeTask',
                description: 'Execute a task dispatched by AgentAbject (create or modify)',
                parameters: [
                  { name: 'tupleId', type: { kind: 'primitive', primitive: 'string' }, description: 'TupleSpace tuple ID' },
                  { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID', optional: true },
                  { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'Task description' },
                  { name: 'type', type: { kind: 'primitive', primitive: 'string' }, description: 'Task type (create or modify)' },
                  { name: 'data', type: { kind: 'object', properties: {} }, description: 'Task-specific data', optional: true },
                ],
                returns: { kind: 'reference', reference: 'CreationResult' },
              },
              {
                name: 'getObjectGraph',
                description: 'Get the object dependency graph',
                parameters: [],
                returns: {
                  kind: 'object',
                  properties: {
                    nodes: {
                      kind: 'array',
                      elementType: { kind: 'primitive', primitive: 'string' },
                    },
                    edges: {
                      kind: 'array',
                      elementType: {
                        kind: 'object',
                        properties: {
                          from: { kind: 'primitive', primitive: 'string' },
                          to: { kind: 'primitive', primitive: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            ],
            events: [
              {
                name: 'objectCreated',
                description: 'New object was created',
                payload: { kind: 'reference', reference: 'CreationResult' },
              },
              {
                name: 'objectModified',
                description: 'Object was modified',
                payload: { kind: 'reference', reference: 'CreationResult' },
              },
              {
                name: 'progress',
                description: 'Progress update during object creation',
                payload: {
                  kind: 'object',
                  properties: {
                    phase: { kind: 'primitive', primitive: 'string' },
                    message: { kind: 'primitive', primitive: 'string' },
                  },
                },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'ui', 'creation'],
      },
    });

    this.setupHandlers();
  }

  private waitForTaskResult(ticketId: string, timeoutMs: number): Promise<{
    ticketId: string; success: boolean; result?: unknown; error?: string;
    steps: number; maxStepsReached?: boolean;
  }> {
    type TaskResult = { ticketId: string; success: boolean; result?: unknown; error?: string; steps: number; maxStepsReached?: boolean };
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

  private setupHandlers(): void {
    // ── Ticket result handler ──
    this.on('taskResult', async (msg: AbjectMessage) => {
      const payload = msg.payload as { ticketId: string };
      const pending = this.pendingTickets.get(payload.ticketId);
      if (pending) {
        this.pendingTickets.delete(payload.ticketId);
        pending.resolve(payload);
      }
    });

    this.on('taskStream', async (msg: AbjectMessage) => {
      const { ticketId, content, done } = msg.payload as { ticketId: string; content: string; done: boolean };
      const callerId = this.ticketToCallerId.get(ticketId);
      if (callerId) {
        this.send(event(this.id, callerId, 'taskStream', { content, done }));
      }
    });

    this.on('taskProgress', async (msg: AbjectMessage) => {
      // Reset pending ticket timeouts on agent progress
      this.resetPendingTicketTimeouts();

      const { ticketId, step, maxSteps, phase, action } = msg.payload as {
        ticketId: string; step: number; maxSteps: number; phase: string; action?: string;
      };
      const callerId = this.ticketToCallerId.get(ticketId);
      if (callerId) {
        this.send(event(this.id, callerId, 'taskProgress', { step, maxSteps, phase, action }));
      }
    });

    this.on('create', async (msg: AbjectMessage) => {
      const { prompt, context, goalId } = msg.payload as CreateObjectRequest & { goalId?: string };

      // Route through AgentAbject if available — jobs become visible in JobBrowser
      if (this.agentAbjectId) {
        const taskId = `create-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        this.creationTasks.set(taskId, {
          prompt,
          context,
          callerId: msg.routing.from,
          deferredMsg: msg,
          goalId,
        });
        this.runCreationViaAgent(taskId);
        return DEFERRED_REPLY;
      }

      // Fallback: direct execution when AgentAbject is unavailable
      return this.createObject(prompt, context, msg.routing.from);
    });

    this.on('modify', async (msg: AbjectMessage) => {
      const { objectId, prompt } = msg.payload as ModifyObjectRequest;
      return this.modifyObject(objectId, prompt, msg.routing.from);
    });

    this.on('suggest', async (msg: AbjectMessage) => {
      const { context } = msg.payload as { context: string };
      return this.suggestObjects(context);
    });

    this.on('listAvailable', async () => {
      return this.listAvailableObjects();
    });

    this.on('getObjectGraph', async () => {
      return this.getObjectGraph();
    });

    // Reset timeouts on streaming LLM chunks and forward progress upstream (throttled)
    let lastChunkForward = 0;
    this.on('llmChunk', async () => {
      if (this._currentLlmMsgId) this.resetRequestTimeout(this._currentLlmMsgId);
      this.resetPendingTicketTimeouts();
      // Forward upstream at most once per second to reset AgentAbject's dispatch timer
      const now = Date.now();
      if (this._currentCallerId && this._currentCallerId !== this.id && now - lastChunkForward >= 1000) {
        lastChunkForward = now;
        this.send(
          event(this.id, this._currentCallerId, 'progress', {
            phase: 'llm-streaming', message: 'LLM generating...',
          })
        );
      }
    });

    // Forward LLM keep-alive progress events to the upstream caller
    this.on('progress', async (msg: AbjectMessage) => {
      // Reset the active LLM request timeout so long-running calls don't expire
      if (this._currentLlmMsgId) this.resetRequestTimeout(this._currentLlmMsgId);
      // Reset pending ticket timeouts (waitForTaskResult timers)
      this.resetPendingTicketTimeouts();

      // Guard: never forward progress to ourselves — that creates an infinite loop
      if (this._currentCallerId && this._currentCallerId !== this.id) {
        const payload = msg.payload as { phase?: string; message?: string };
        await this.reportProgress(
          this._currentCallerId,
          payload.phase ?? 'llm',
          payload.message ?? 'LLM processing...'
        );
      }
    });

    // ── AgentAbject callback handlers (for delegation) ──

    this.on('agentObserve', async (msg: AbjectMessage) => {
      const { taskId } = msg.payload as { taskId: string; step: number };
      const extra = this.creationTasks.get(taskId);
      if (!extra) return { observation: 'ObjectCreator ready. Available actions: create_object (new object from prompt), modify_object (update existing object by ID).' };

      if (extra.result) {
        if (extra.result.success) {
          return {
            observation: `Creation complete. Object "${extra.result.manifest?.name ?? 'unknown'}" spawned as ${extra.result.objectId}. Dependencies: ${(extra.result.usedObjects ?? []).join(', ') || 'none'}.`,
          };
        }
        return { observation: `Creation failed: ${extra.result.error}` };
      }

      return { observation: `Task: "${extra.prompt}". Execute create_object to build it.` };
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      const { taskId, action } = msg.payload as { taskId: string; step: number; action: AgentAction };
      const extra = this.creationTasks.get(taskId);

      // Set current goal ID for progress reporting during creation
      this._currentGoalId = extra?.goalId;

      switch (action.action) {
        case 'create_object': {
          const prompt = extra?.prompt ?? (action.prompt ?? action.description ?? action.task) as string;
          if (!prompt) return { success: false, error: 'No prompt provided for create_object' };
          const context = extra?.context ?? (action.context as string | undefined);
          const result = await this.createObject(prompt, context, extra?.callerId ?? msg.routing.from);
          if (extra) extra.result = result;
          this._currentGoalId = undefined;
          return { success: result.success, data: result, error: result.error };
        }
        case 'modify_object': {
          const objectId = action.objectId as string;
          const prompt = (action.prompt ?? action.description) as string;
          if (!objectId || !prompt) return { success: false, error: 'objectId and prompt required for modify_object' };
          const result = await this.modifyObject(objectId as AbjectId, prompt, msg.routing.from);
          return { success: result.success, data: result, error: result.error };
        }
        default:
          return { success: false, error: `Unknown action: ${action.action}` };
      }
    });

    this.on('executeTask', async (msg: AbjectMessage) => {
      const { goalId, description, data, type, callerId: explicitCallerId } = msg.payload as {
        tupleId: string; goalId?: string; description: string;
        data?: Record<string, unknown>; type: string; callerId?: string;
      };
      log.info(`executeTask type=${type} goalId=${goalId?.slice(0, 8) ?? '?'} data=${JSON.stringify(data)?.slice(0, 200)} from=${msg.routing.from.slice(0, 8)} callerId=${explicitCallerId?.slice(0, 8) ?? 'none'} desc="${description.slice(0, 60)}"`);
      this._currentGoalId = goalId;
      // Use explicit callerId (from AgentAbject via JobManager) or fall back to
      // msg.routing.from. This ensures progress reaches AgentAbject even when
      // the executeTask is routed through JobManager.
      const callerId = (explicitCallerId as AbjectId) ?? msg.routing.from;
      try {
        // Try to resolve a target object from any data field or the description
        const objectId = await this.resolveModifyTarget(data, description);
        if (objectId) {
          log.info(`executeTask modify object=${objectId.slice(0, 8)}`);
          return await this.modifyObject(objectId as AbjectId, description, callerId);
        }
        log.info(`executeTask create`);
        // If the task data includes a role hint (from AgentCreator decomposition),
        // pass it as context so Phase 1 picks the right pattern.
        const roleContextMap: Record<string, string> = {
          agent: 'This object MUST follow the Agent Object pattern: register with AgentAbject, implement executeTask/agentObserve/agentAct handlers, use tags ["agent", "autostart"].',
          scheduler: 'This object MUST follow the Scheduler Object pattern: use Timer for periodic ticking, submit Jobs via JobManager.submitJob when triggers fire (NEVER call GoalManager directly), use tags ["scheduler", "autostart"].',
          watcher: 'This object MUST follow the Event Watcher Object pattern: observe other objects via addDependent, submit Jobs via JobManager.submitJob when events match (NEVER call GoalManager directly), use tags ["watcher", "autostart"].',
        };
        const roleContext = data?.role ? roleContextMap[data.role as string] : undefined;
        return await this.createObject(description, roleContext, callerId);
      } finally {
        this._currentGoalId = undefined;
      }
    });

    this.on('agentPhaseChanged', async () => { /* no-op */ });
    this.on('agentIntermediateAction', async () => { /* no-op */ });
    this.on('agentActionResult', async () => { /* no-op */ });

  }

  protected override async onInit(): Promise<void> {
    await this.fetchTheme();
    this.llmId = await this.requireDep('LLM');
    this.registryId = await this.requireDep('Registry');
    this.factoryId = await this.requireDep('Factory');
    this.negotiatorId = (await this.discoverDep('Negotiator')) ?? undefined;
    this.abjectStoreId = await this.discoverDep('AbjectStore') ?? undefined;
    this.systemRegistryId = await this.discoverDep('SystemRegistry') ?? undefined;
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    this.agentAbjectId = await this.discoverDep('AgentAbject') ?? undefined;
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;
    this.screenshotId = await this.discoverDep('Screenshot') ?? undefined;

    // Register as an agent for discoverability and delegation
    if (this.agentAbjectId) {
      try {
        await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
          name: 'ObjectCreator',
          description: 'Creates new objects and modifies existing objects from natural language. Users may refer to objects as "apps". Handles object creation, fixing object UIs, changing object behavior, adding features to objects, and redesigning objects. Also creates bridges, proxies, relays, wrappers, adapters, and integrations (including objects that wrap an installed skill or MCP server into a reusable Abject). Any task about building, authoring, creating, fixing, changing, updating, modifying, redesigning, or improving an object belongs to this agent, even when that object talks to a skill or external service.',
          config: {
            maxSteps: 10,
            skipFirstObservation: true,
            terminalActions: {
              done: { type: 'success', resultFields: ['result'] },
              fail: { type: 'error', resultFields: ['reason'] },
            },
          },
        }));
      } catch {
        // AgentAbject may not be ready yet — non-fatal
      }
    }
  }

  /**
   * Route a creation task through AgentAbject so each phase appears as a job
   * in JobBrowser. Uses DEFERRED_REPLY on the original `create` message.
   * Submits a ticket to AgentAbject and awaits the taskResult event.
   */
  private async runCreationViaAgent(taskId: string): Promise<void> {
    const extra = this.creationTasks.get(taskId)!;
    let innerTicketId: string | undefined;
    try {
      // Submit ticket — returns immediately
      const { ticketId } = await this.request<{ ticketId: string }>(
        request(this.id, this.agentAbjectId!, 'startTask', {
          taskId,
          task: extra.prompt,
          systemPrompt: this.buildCreationSystemPrompt(),
          goalId: extra.goalId,
          config: {
            maxSteps: 10,
            skipFirstObservation: true,
            queueName: `object-creator-${this.id}`,
          },
        }),
      );
      innerTicketId = ticketId;
      if (extra.callerId) this.ticketToCallerId.set(ticketId, extra.callerId);

      // Wait for taskResult event
      const result = await this.waitForTaskResult(ticketId, 310000);

      // Build a CreationResult from agent task result + stored creation state
      const creationResult: CreationResult = extra.result ?? {
        success: result.success,
        error: result.error,
      };
      this.sendDeferredReply(extra.deferredMsg, creationResult);
    } catch (err) {
      this.sendDeferredReply(extra.deferredMsg, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      } as CreationResult);
    } finally {
      if (innerTicketId) this.ticketToCallerId.delete(innerTicketId);
      this.creationTasks.delete(taskId);
    }
  }

  private buildCreationSystemPrompt(): string {
    return `You are ObjectCreator, responsible for creating objects from natural language descriptions.

Available actions (output ONE JSON object per turn):
- create_object: Execute the full creation pipeline (discover deps, design manifest, generate code, spawn, connect).
  { "action": "create_object", "reasoning": "Creating the requested object" }
- done: Report success after create_object completes.
  { "action": "done", "result": "Created [object name] successfully" }
- fail: Report failure if create_object failed.
  { "action": "fail", "reason": "..." }

Always begin by executing create_object. After it completes, report done or fail.`;
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## ObjectCreator: Object Creation and Modification Agent

### What I Handle
I create brand-new objects and modify existing ones from natural language descriptions.
I generate the code, manifest, and handlers for new Abjects.

Examples of tasks I handle well:
- "Create a todo list app". I build a new widget from scratch.
- "Make a countdown timer". I create a new object with UI.
- "Add a reset button to the Counter". I modify existing object code.
- "Create a messaging bridge", "build a service proxy", "wrap this MCP server in an object", "make a relay between X and Y". I generate bridge, proxy, relay, wrapper, adapter, and integration objects, including ones that poll or forward between an installed skill/MCP server and another Abject.
- Any task that requires building or changing an object's implementation.

### Stays with Other Agents
- Pure runtime interaction with existing objects (calling their methods, fetching data from them) when the source stays as-is.
- Browsing websites or navigating web pages.
- Driving a running app (drawing on its canvas, clicking its buttons) while the source stays as-is.
- Installing, enabling, or configuring skills and MCP servers. Wrapping one in a new object belongs here; the install and credential setup stay with skill management.

### Create a New Object

  const result = await call(
    await dep('ObjectCreator'), 'create',
    { prompt: 'a simple counter widget', goalId: 'optional-goal-id' });
  // result: { success: boolean, objectId?: string, manifest?: AbjectManifest,
  //           code?: string, error?: string, usedObjects?: string[] }

The created object is ALREADY initialized and registered in the system. Call show() directly on the returned objectId to display it; skip init():

  if (result.success && result.objectId) {
    await call(result.objectId, 'show', {});
  }

Always create and show in ONE step. The returned objectId and manifest already carry everything needed, so skip any extra lookup, init, or discovery steps.

### Modify an Existing Object

  const result = await call(
    await dep('ObjectCreator'), 'modify',
    { objectId: 'the-object-id', prompt: 'add a reset button' });
  // Returns the same CreationResult shape as create

### Get Suggestions

  const suggestions = await call(
    await dep('ObjectCreator'), 'suggest',
    { context: 'I want to track my daily habits' });
  // Returns string[] of suggested object ideas

### IMPORTANT
- The interface ID is 'abjects:object-creator' (with the hyphen).
- create is a long-running operation (may take 30-60 seconds). ObjectCreator emits 'progress' events during creation.
- The returned objectId is ready to use immediately. Call it directly; registry lookup and init() are already handled.
- The returned objectId can be called directly. Interface IDs are resolved automatically.
- Pass goalId to link creation progress to an existing Goal (from GoalManager). If omitted, a goal is auto-created by AgentAbject.`;
  }

  protected override async handleAsk(question: string): Promise<string> {
    return this.askLlm(this.askPrompt(question), question, 'fast');
  }

  /**
   * Call LLM via streaming to prevent timeouts on long code generation.
   * Returns the same shape as complete() for caller compatibility.
   */
  private async llmComplete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult> {
    const msg = request(this.id, this.llmId!, 'stream', { messages, options });
    this._currentLlmMsgId = msg.header.messageId;
    try {
      const result = await this.request<{ content: string }>(msg, 310000);
      return {
        content: result.content,
        finishReason: 'stop',
      };
    } finally {
      this._currentLlmMsgId = undefined;
    }
  }

  /**
   * List objects from registry via message passing.
   */
  private async registryList(): Promise<ObjectRegistration[]> {
    return this.request<ObjectRegistration[]>(
      request(this.id, this.registryId!, 'list', {})
    );
  }

  /**
   * List objects from the system (global) registry via message passing.
   */
  private async systemRegistryList(): Promise<ObjectRegistration[]> {
    if (!this.systemRegistryId) return [];
    return this.request<ObjectRegistration[]>(
      request(this.id, this.systemRegistryId, 'list', {})
    );
  }

  /**
   * Look up an object in the registry via message passing.
   */
  private async registryLookup(objectId: AbjectId): Promise<ObjectRegistration | null> {
    return this.request<ObjectRegistration | null>(
      request(this.id, this.registryId!, 'lookup', { objectId })
    );
  }

  /**
   * Get object source from registry via message passing.
   */
  private async registryGetSource(objectId: AbjectId): Promise<string | null> {
    return this.request<string | null>(
      request(this.id, this.registryId!, 'getSource', { objectId })
    );
  }

  /**
   * Spawn an object via factory message passing.
   */
  private async factorySpawn(spawnReq: SpawnRequest): Promise<SpawnResult> {
    return this.request<SpawnResult>(
      request(this.id, this.factoryId!, 'spawn', spawnReq)
    );
  }

  /**
   * Update an object's manifest in the registry (re-indexes).
   */
  private async registryUpdateManifest(objectId: AbjectId, manifest: AbjectManifest): Promise<boolean> {
    return this.request<boolean>(
      request(this.id, this.registryId!, 'updateManifest', { objectId, manifest })
    );
  }

  /**
   * Update an object's source in the registry.
   */
  private async registryUpdateSource(objectId: AbjectId, source: string): Promise<boolean> {
    return this.request<boolean>(
      request(this.id, this.registryId!, 'updateSource', { objectId, source })
    );
  }

  private async reportProgress(callerId: AbjectId, phase: string, message: string): Promise<void> {
    // Update goal if available (GoalManager updates display via changed events)
    if (this._currentGoalId && this.goalManagerId) {
      this.send(event(this.id, this.goalManagerId, 'updateProgress', {
        goalId: this._currentGoalId,
        message,
        phase,
        agentName: 'ObjectCreator',
      }));
    }
    // Also send progress event to caller (backward compat)
    try {
      this.send(
        event(this.id, callerId, 'progress', { phase, message })
      );
    } catch { /* best-effort */ }
  }

  // ── Post-Spawn Probe Validation ──────────────────────────────────

  /**
   * Phase 5b: Probe a live ScriptableAbject to validate that all dependencies
   * referenced in its source (this.dep('...') / this.find('...')) can be resolved.
   */
  private async probeObject(objectId: AbjectId): Promise<{ success: boolean; missingDeps: string[]; error: string }> {
    try {
      const result = await this.request<{ success: boolean; missingDeps: string[]; error: string }>(
        request(this.id, objectId, 'probe', {}),
        15000
      );
      return result;
    } catch (err) {
      return { success: false, missingDeps: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Phase 5c: Retry with probe feedback — re-run dependency selection with error context,
   * regenerate handler code, and apply the fix to the live object.
   */
  private async retryWithProbeFeedback(
    objectId: AbjectId,
    manifest: AbjectManifest,
    prompt: string,
    previousCode: string,
    probeError: string,
    originalDeps: SelectedDependency[],
    usedObjects: string[],
    context: string | undefined,
    callerId: AbjectId | undefined
  ): Promise<{ success: boolean; code?: string; deps?: SelectedDependency[]; error?: string }> {
    // 1. Re-ask Registry with augmented prompt including probe error
    if (callerId) await this.reportProgress(callerId, '5c', 'Re-selecting dependencies with probe feedback...');
    const augmentedPrompt =
      `${prompt}\n\nIMPORTANT: A previous attempt failed because these dependencies are missing: ${probeError}. Make sure to include them.`;
    const newSelectedNames = await this.askRegistryForDependencies(augmentedPrompt);
    log.info('probe-retry Re-selected dependencies:', newSelectedNames);

    // 2. Identify newly discovered deps (diff against originals)
    const originalNames = new Set(originalDeps.map((d) => d.name.toLowerCase()));
    const newNames = newSelectedNames.filter((n) => !originalNames.has(n.toLowerCase()));

    // 3. Fetch manifests, questions, and usage guides for new deps only
    let allDeps = [...originalDeps];
    let depContext: string;

    if (newNames.length > 0) {
      if (callerId) await this.reportProgress(callerId, '5c', `Learning about new deps: ${newNames.join(', ')}...`);
      const newDeps = await this.fetchFullManifests(newNames);
      const newQuestions = await this.generateTargetedQuestions(prompt, newDeps);
      const newGuides = await this.fetchUsageGuides(newDeps, newQuestions, callerId);

      // Merge new deps with originals
      allDeps = [...originalDeps, ...newDeps];

      // Re-fetch usage guides for all deps (originals already have context, but
      // we need a unified depContext string)
      const allGuides = await this.fetchUsageGuides(originalDeps, undefined, undefined);
      for (const [k, v] of newGuides) allGuides.set(k, v);
      depContext = this.formatFullManifestContext(allDeps, allGuides);
    } else {
      depContext = this.formatFullManifestContext(allDeps);
    }

    // 4. Re-run Phase 2 with updated depContext and error feedback
    if (callerId) await this.reportProgress(callerId, '5c', 'Regenerating handler code...');
    const errorFeedback = `Runtime probe found missing dependencies: ${probeError}. ` +
      `The code references objects that don't exist. Fix the code to use only the available dependencies listed below.`;
    let code = await this.regenerateHandlerCode(
      manifest, prompt, depContext, usedObjects, previousCode, errorFeedback, context
    );
    if (!code) {
      return { success: false, error: 'Failed to regenerate handler code after probe feedback' };
    }

    // 5. Phases 3+4: verify + compile
    if (callerId) await this.reportProgress(callerId, '5c', 'Verifying regenerated code...');
    const verified = this.verifyAndFix(manifest, code);
    code = verified.code;

    if (verified.mismatches.length > 0) {
      try {
        const llmFixed = await this.llmVerifyAndFix(verified.manifest, code, verified.mismatches);
        if (!ScriptableAbject.tryCompile(llmFixed.code)) {
          code = llmFixed.code;
        }
      } catch { /* continue with current code */ }
    }

    const compileError = ScriptableAbject.tryCompile(code);
    if (compileError) {
      return { success: false, error: `Compilation failed after probe retry: ${compileError}` };
    }

    // 6. Clean up partial UI (in case show() left partial windows)
    if (this.widgetManagerId) {
      try {
        await this.request(
          request(this.id, this.widgetManagerId,
            'destroyWindowsForOwner', { ownerId: objectId })
        );
      } catch { /* best effort */ }
    }

    // 7. Apply fix via updateSource to the live object (hide → swap → show)
    if (callerId) await this.reportProgress(callerId, '5c', 'Applying fixed code...');
    try {
      const updateResult = await this.request<{ success: boolean; error?: string }>(
        request(this.id, objectId, 'updateSource', { source: code }),
        30000
      );
      if (!updateResult.success) {
        return { success: false, error: `Failed to apply fixed source: ${updateResult.error}` };
      }
    } catch (err) {
      return { success: false, error: `Failed to apply fixed source: ${err instanceof Error ? err.message : String(err)}` };
    }

    // 8. Update registry source and persist
    await this.registryUpdateSource(objectId, code);
    if (this.abjectStoreId) {
      this.request(
        request(this.id, this.abjectStoreId, 'save', {
          objectId: objectId as string, manifest, source: code, owner: this.id as string,
        })
      ).catch(err => log.warn('probe-retry Failed to persist:', err));
    }

    return { success: true, code, deps: allDeps };
  }

  /**
   * Phase 5d: Visual inspection — ask the LLM to evaluate a screenshot of the
   * newly created object's window and provide corrective code if needed.
   * Single iteration, non-fatal.
   */
  private async visualInspection(
    objectId: AbjectId,
    manifest: AbjectManifest,
    prompt: string,
    currentCode: string,
    screenshot: { imageBase64: string; width: number; height: number },
    callerId: AbjectId | undefined,
  ): Promise<{ code?: string }> {
    const messages: LLMMessage[] = [
      systemMessage(
        'You are reviewing a visual UI object that was just created. ' +
        'A screenshot of its window is attached. Evaluate whether it looks correct ' +
        'for the user\'s request. If it looks good, respond with just "LOOKS_GOOD". ' +
        'If there are visual issues (wrong layout, missing elements, broken rendering, etc.), ' +
        'provide the corrected handler map in a ```javascript code block.'
      ),
      userMessageWithImages(
        `User requested: "${prompt}"\n\nObject: ${manifest.name}\n\n` +
        `Current handler code:\n\`\`\`javascript\n${currentCode}\n\`\`\`\n\n` +
        `Screenshot of the result (${screenshot.width}x${screenshot.height}):`,
        [{ mediaType: 'image/png' as const, data: screenshot.imageBase64 }],
      ),
    ];

    const result = await this.llmComplete(messages, { tier: 'smart' });

    if (result.content.includes('LOOKS_GOOD')) {
      log.info('Visual inspection: looks good');
      return {};
    }

    // Extract corrected code
    const codeMatch = result.content.match(/```(?:javascript|js)\s*([\s\S]*?)\s*```/);
    if (!codeMatch) {
      log.info('Visual inspection: LLM provided feedback but no code block');
      return {};
    }

    let newCode = codeMatch[1];
    log.info('Visual inspection: applying corrective code');

    // Verify and compile
    const verified = this.verifyAndFix(manifest, newCode);
    newCode = verified.code;
    const compileError = ScriptableAbject.tryCompile(newCode);
    if (compileError) {
      log.warn('Visual inspection: corrective code failed to compile:', compileError);
      return {};
    }

    // Apply to live object
    try {
      await this.request(
        request(this.id, objectId, 'updateSource', { source: newCode }),
        30000,
      );
      if (this.registryId) {
        await this.registryUpdateSource(objectId, newCode);
      }
      return { code: newCode };
    } catch (err) {
      log.warn('Visual inspection: failed to apply corrective code:', err instanceof Error ? err.message : String(err));
      return {};
    }
  }

  // ── Multi-Phase Discovery Pipeline ────────────────────────────────

  /**
   * Phase 0a: Get summaries (name + description) of all registered objects.
   * Queries both the workspace registry and the system registry, deduplicating by ID.
   */
  /**
   * Phase 0: Ask the Registry which objects the new object needs as dependencies.
   * Uses the Registry's ask protocol, which has access to the full catalog of
   * registered objects and their capabilities.
   */
  private async askRegistryForDependencies(prompt: string): Promise<string[]> {
    const registryId = this.registryId ?? this.systemRegistryId;
    if (!registryId) return [];

    const question =
      `I'm building an object that: ${prompt}\n\n` +
      'IMPORTANT: Objects run in a sandboxed environment with NO access to browser globals (fetch, setTimeout, localStorage, etc). ' +
      'If the object needs HTTP requests, timers, storage, or other capabilities, it MUST depend on the registered object that provides them.\n\n' +
      'TOOL SELECTION HIERARCHY for web access:\n' +
      '1. HttpClient (+ WebParser for HTML) -- DEFAULT for fetching web content: news sites, RSS feeds, APIs, HTML scraping.\n' +
      '2. WebBrowser -- for pages that require JavaScript rendering or interactive control.\n' +
      '3. WebAgent -- for autonomous multi-step browsing with AI planning (very heavy).\n\n' +
      'AUTONOMOUS PATTERN HIERARCHY:\n' +
      '- If the request mentions scheduling, recurring, periodic, daily, hourly, "every N minutes/hours", "at X time", cron, or timer-based behavior: include Timer, GoalManager, TupleSpace\n' +
      '- If the request mentions "agent", autonomous task execution, or participating in task dispatch: include AgentAbject, GoalManager\n' +
      '- If the request mentions watching, monitoring, reacting to events from other objects: include GoalManager, TupleSpace\n\n' +
      'Which registered objects should it depend on? Return just the object names, one per line. If no dependencies are needed, return "None".';

    try {
      const answer = await this.request<string>(
        request(this.id, registryId, 'ask', { question }),
        60000,
      );
      const content = (typeof answer === 'string' ? answer : String(answer)).trim();
      if (content.toLowerCase() === 'none') return [];
      return content
        .split('\n')
        .map((n) => n.trim().replace(/^[-*•]\s*/, '').replace(/\*\*/g, ''))
        .filter((n) => n.length > 0 && n.toLowerCase() !== 'none');
    } catch (err) {
      log.warn('askRegistryForDependencies failed:', err instanceof Error ? err.message : String(err));
      return [];
    }
  }

  /**
   * Resolve an object name to an ID via Registry discover message.
   */
  private async resolveObjectByName(name: string): Promise<ObjectSummary | null> {
    if (!this.registryId) return null;
    try {
      const results = await this.request<ObjectRegistration[]>(
        request(this.id, this.registryId, 'discover', { name })
      );
      if (results.length > 0) {
        const r = results[0];
        return { id: r.id, name: r.name ?? r.manifest.name, description: r.manifest.description };
      }
    } catch { /* not found in workspace registry */ }

    // Try system registry
    if (this.systemRegistryId) {
      try {
        const results = await this.request<ObjectRegistration[]>(
          request(this.id, this.systemRegistryId, 'discover', { name })
        );
        if (results.length > 0) {
          const r = results[0];
          return { id: r.id, name: r.name ?? r.manifest.name, description: r.manifest.description };
        }
      } catch { /* not found */ }
    }

    return null;
  }

  /**
   * Ask an object to describe itself via the introspect protocol.
   */
  private async introspect(objectId: AbjectId): Promise<IntrospectResult | null> {
    try {
      return await this.request<IntrospectResult>(
        request(this.id, objectId, 'describe', {})
      );
    } catch (err) {
      log.warn(`introspect ${objectId.slice(0, 8)} failed:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Phase 0c: Ask selected objects to describe themselves via introspect protocol.
   */
  private async fetchFullManifests(
    selectedNames: string[],
  ): Promise<SelectedDependency[]> {
    const deps: SelectedDependency[] = [];

    for (const name of selectedNames) {
      const resolved = await this.resolveObjectByName(name);
      if (!resolved) continue;

      const result = await this.introspect(resolved.id);
      if (result) {
        deps.push({
          id: resolved.id,
          name: result.manifest.name,
          manifest: result.manifest,
          description: result.description,
        });
      }
    }

    return deps;
  }

  /**
   * Ask a dependency about its usage via the introspect 'ask' protocol.
   * Returns null on failure (LLM not available, timeout, etc.).
   */
  private async askDependency(objectId: AbjectId, question: string): Promise<string | null> {
    try {
      return await this.request<string>(
        request(this.id, objectId, 'ask', { question }),
        60000
      );
    } catch (err) {
      log.warn(`askDependency ${objectId.slice(0, 8)} failed:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  }

  /**
   * Phase 0c5: Generate targeted questions for each dependency based on the user's prompt.
   * Returns a Map of dep name → targeted question. On failure, returns an empty Map
   * so Phase 0d falls back to generic questions.
   */
  private async generateTargetedQuestions(
    prompt: string,
    deps: SelectedDependency[]
  ): Promise<Map<string, string>> {
    if (deps.length === 0 || !this.llmId) return new Map();

    try {
      const depList = deps
        .map((d) => `- ${d.name}: ${d.description.slice(0, 300)}`)
        .join('\n');

      const result = await this.llmComplete([
        systemMessage(
          'You are helping build a new object in a distributed system. ' +
          'Given the user\'s goal and a list of dependency objects, generate ONE targeted question per dependency. ' +
          'Each question should ask the dependency specifically how to accomplish what the user needs, referencing concrete methods or events.\n\n' +
          'Format: one line per dependency, exactly like this:\n' +
          '[DepName]: Your targeted question here?\n\n' +
          'Output ONLY the questions, one per line. Nothing else.'
        ),
        userMessage(
          `User wants to create: ${prompt}\n\nDependencies:\n${depList}\n\n` +
          `Generate a targeted question for each dependency.`
        ),
      ], { tier: 'balanced' });

      return this.parseTargetedQuestions(result.content, deps.map((d) => d.name));
    } catch (err) {
      log.warn('Failed to generate targeted questions, falling back to generic:', err);
      return new Map();
    }
  }

  /**
   * Parse LLM response for targeted questions. Matches lines like "[Name]: question" or "Name: question".
   * Uses case-insensitive fuzzy matching against known dep names.
   */
  private parseTargetedQuestions(
    content: string,
    depNames: string[]
  ): Map<string, string> {
    const questions = new Map<string, string>();
    const nameMap = new Map(depNames.map((n) => [n.toLowerCase(), n]));

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Match "[Name]: question" or "Name: question" (with optional leading "- ")
      const match = trimmed.match(/^-?\s*\[?([^\]:\n]+)\]?\s*:\s*(.+)/);
      if (!match) continue;

      const rawName = match[1].trim();
      const question = match[2].trim();
      if (!question) continue;

      const canonical = nameMap.get(rawName.toLowerCase());
      if (canonical) {
        questions.set(canonical, question);
      }
    }

    return questions;
  }

  /**
   * Ask each dependency in parallel for a usage guide via the 'ask' protocol.
   * If customQuestions is provided, uses targeted questions per dep; otherwise falls back to generic.
   * Reports per-dependency progress when callerId is provided.
   */
  private async fetchUsageGuides(
    deps: SelectedDependency[],
    customQuestions?: Map<string, string>,
    callerId?: AbjectId
  ): Promise<Map<string, string>> {
    const guides = new Map<string, string>();
    if (deps.length === 0) return guides;

    const genericQuestion =
      'How should another object use your methods? Give a concise guide with example this.call() invocations, event handler patterns, and any important constraints.';

    const promises = deps.map(async (dep) => {
      const question = customQuestions?.get(dep.name) ?? genericQuestion;
      if (callerId) await this.reportProgress(callerId, '0d', `Asking ${dep.name}: ${question}`);
      const guide = await this.askDependency(dep.id, question);
      if (guide) {
        guides.set(dep.name, guide);
      }
    });

    await Promise.all(promises);
    return guides;
  }

  /**
   * Format full manifest context for LLM prompts using introspect descriptions
   * and LLM-powered usage guides from the 'ask' protocol.
   */
  private formatFullManifestContext(deps: SelectedDependency[], usageGuides?: Map<string, string>): string {
    if (deps.length === 0) return 'None';

    return deps
      .map((dep) => {
        let text = `## ${dep.name} (id available as this.dep('${dep.name}'))\n${dep.description}\n\n  Usage: this.call(this.dep('${dep.name}'), methodName, payload)`;
        const guide = usageGuides?.get(dep.name);
        if (guide) {
          text += `\n\n### Usage Guide (from ${dep.name} itself):\n${guide}`;
        }
        return text;
      })
      .join('\n\n---\n\n');
  }

  // ── Object Creation ───────────────────────────────────────────────

  /**
   * Create a new object from a natural language prompt.
   * Uses multi-phase pipeline: discovery → manifest → code → verify → spawn.
   */
  async createObject(prompt: string, context?: string, callerId?: AbjectId): Promise<CreationResult> {
    require(this.llmId !== undefined, 'LLM not set');
    require(this.registryId !== undefined, 'Registry not set');

    try {
      this._currentCallerId = callerId;

      // Phase 0: Ask Registry which objects the new object needs
      if (callerId) await this.reportProgress(callerId, '0', 'Asking Registry for dependencies...');
      const selectedNames = await this.askRegistryForDependencies(prompt);
      log.info('Selected dependencies:', selectedNames);

      // Phase 0c: Fetch full manifests for selected dependencies
      const depNames = selectedNames.join(', ') || 'none';
      if (callerId) await this.reportProgress(callerId, '0c', `Learning about ${depNames}...`);
      let deps = await this.fetchFullManifests(selectedNames);
      log.info('Fetched manifests for:', deps.map((d) => d.name));

      // Phase 0c5: Generate targeted questions for each dependency
      if (callerId) await this.reportProgress(callerId, '0c5', 'Formulating questions...');
      const targetedQuestions = await this.generateTargetedQuestions(prompt, deps);
      log.info('Generated targeted questions for:', Array.from(targetedQuestions.keys()));

      // Phase 0d: Ask each dependency for usage guides (with targeted questions)
      const usageGuides = await this.fetchUsageGuides(deps, targetedQuestions, callerId);
      log.info('Got usage guides from:', Array.from(usageGuides.keys()));

      const depContext = this.formatFullManifestContext(deps, usageGuides);

      // Phase 1: Generate manifest
      if (callerId) await this.reportProgress(callerId, '1', 'Designing object manifest...');
      const phase1 = await this.generateManifest(prompt, depContext, context);
      if (!phase1.manifest) {
        this._currentCallerId = undefined;
        return { success: false, error: 'Phase 1: Failed to generate valid manifest' };
      }

      // Phases 2–4: Generate handler code, verify, compile — with retry loop
      const MAX_CODE_ATTEMPTS = 3;
      let code: string | undefined;
      let manifest = phase1.manifest;
      let lastError = '';

      for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
        // Phase 2: Generate handler code (with feedback on retry)
        if (attempt === 1) {
          if (callerId) await this.reportProgress(callerId, '2', 'Generating handler code...');
          code = await this.generateHandlerCode(
            manifest, prompt, depContext, phase1.usedObjects, context
          );
        } else {
          if (callerId) await this.reportProgress(callerId, '2', `Generating handler code (retry ${attempt}/${MAX_CODE_ATTEMPTS})...`);
          log.info(`Retry ${attempt}/${MAX_CODE_ATTEMPTS}: ${lastError}`);
          code = await this.regenerateHandlerCode(
            manifest, prompt, depContext, phase1.usedObjects, code ?? '', lastError, context
          );
        }
        if (!code) {
          lastError = 'Failed to generate handler code (LLM did not return a javascript code block)';
          log.warn(`Attempt ${attempt}: ${lastError}`);
          continue;
        }

        // Phase 3: Verify manifest/code consistency
        if (callerId) await this.reportProgress(callerId, '3', 'Verifying code...');
        const verified = this.verifyAndFix(manifest, code);
        manifest = verified.manifest;
        code = verified.code;
        log.info(`Phase 3 mismatches: ${verified.mismatches.length > 0 ? verified.mismatches.join('; ') : 'none'}`);

        // Phase 3b: LLM-assisted fix if needed
        if (verified.mismatches.length > 0) {
          try {
            const llmFixed = await this.llmVerifyAndFix(manifest, code, verified.mismatches);
            // Only accept if the fix still compiles — truncated LLM responses break code
            if (!ScriptableAbject.tryCompile(llmFixed.code)) {
              manifest = llmFixed.manifest;
              code = llmFixed.code;
              log.info('Phase 3b: LLM fix accepted');
            } else {
              log.warn('Phase 3b produced non-compiling code, keeping original');
            }
          } catch (err) {
            log.warn('LLM verify/fix failed, continuing:', err);
          }
        }

        // Phase 3c: Re-verify after fixes
        const recheck = this.verifyAndFix(manifest, code);
        manifest = recheck.manifest;
        code = recheck.code;
        const missingHandlers = recheck.mismatches.filter((m) => m.startsWith('Missing handler:'));
        if (missingHandlers.length > 0) {
          lastError = `Handler code is missing required methods: ${missingHandlers.join('; ')}`;
          log.warn(`Attempt ${attempt}: ${lastError}`);
          if (attempt < MAX_CODE_ATTEMPTS) continue;
          return { success: false, error: lastError, code };
        }

        // Phase 4: Compile check
        if (callerId) await this.reportProgress(callerId, '4', 'Compiling...');
        const compileError = ScriptableAbject.tryCompile(code);
        log.info(`Phase 4 compile: ${compileError ? 'FAILED: ' + compileError.slice(0, 200) : 'OK'} (code ${code.length} chars)`);
        if (compileError) {
          // Try a single LLM compile fix
          const fixResult = await this.llmComplete([
            systemMessage(
              'The following JavaScript handler map failed to compile with `new Function()`. ' +
              'Fix it so it is valid plain JavaScript. No TypeScript annotations, no type casts, no interfaces. ' +
              'You MUST keep ALL handler methods — do not remove any. ' +
              'Output ONLY the corrected handler map in a ```javascript code block. Nothing else.'
            ),
            userMessage(`Handler map:\n\`\`\`javascript\n${code}\n\`\`\`\n\nError: ${compileError}`),
          ], { tier: 'balanced' });
          const fixMatch = fixResult.content.match(/```(?:javascript|js)\s*([\s\S]*?)\s*```/);
          if (fixMatch && !ScriptableAbject.tryCompile(fixMatch[1])) {
            code = fixMatch[1];
            log.info('Phase 4: LLM compile fix accepted');
          } else {
            lastError = `Compilation failed: ${compileError}`;
            log.warn(`Attempt ${attempt}: ${lastError}`);
            if (attempt < MAX_CODE_ATTEMPTS) continue;
            return { success: false, error: lastError, code };
          }

          // Re-verify after compile fix — the LLM may have dropped methods
          const postCompileCheck = this.verifyAndFix(manifest, code);
          const postMissing = postCompileCheck.mismatches.filter((m) => m.startsWith('Missing handler:'));
          if (postMissing.length > 0) {
            lastError = `Compile fix dropped required methods: ${postMissing.join('; ')}`;
            log.warn(`Attempt ${attempt}: ${lastError}`);
            if (attempt < MAX_CODE_ATTEMPTS) continue;
            return { success: false, error: lastError, code };
          }
        }

        // All checks passed
        lastError = '';
        break;
      }

      if (lastError) {
        return { success: false, error: lastError, code };
      }

      // Phase 5: Spawn via Factory
      if (callerId) await this.reportProgress(callerId, '5', 'Spawning object...');
      if (this.factoryId) {
        const spawnResult = await this.factorySpawn({
          manifest,
          source: code,
          owner: this.id,
          parentId: this.id,
          registryHint: this.registryId,
        });

        // Phase 5b: Probe validation — check that all deps referenced in source resolve
        if (spawnResult.objectId) {
          if (callerId) await this.reportProgress(callerId, '5b', 'Validating dependencies...');
          let probeResult = await this.probeObject(spawnResult.objectId);
          log.info('Probe result:', probeResult);

          if (!probeResult.success) {
            const MAX_RUNTIME_ATTEMPTS = 2;
            for (let attempt = 1; attempt <= MAX_RUNTIME_ATTEMPTS; attempt++) {
              if (callerId) await this.reportProgress(callerId, '5c', `Runtime error recovery attempt ${attempt}/${MAX_RUNTIME_ATTEMPTS}...`);
              log.info(`Probe retry ${attempt}/${MAX_RUNTIME_ATTEMPTS}: ${probeResult.error}`);

              const retryResult = await this.retryWithProbeFeedback(
                spawnResult.objectId, manifest, prompt, code!, probeResult.error,
                deps, phase1.usedObjects, context, callerId
              );

              if (!retryResult.success) {
                if (attempt === MAX_RUNTIME_ATTEMPTS) {
                  this._currentCallerId = undefined;
                  return { success: false, objectId: spawnResult.objectId, manifest, code, error: retryResult.error };
                }
                continue;
              }

              // Update code and deps for Phase 6 connect
              code = retryResult.code ?? code;
              if (retryResult.deps) deps = retryResult.deps;

              // Re-probe to verify the fix worked
              probeResult = await this.probeObject(spawnResult.objectId);
              log.info('Post-retry probe result:', probeResult);
              if (probeResult.success) break;
            }

            if (!probeResult.success) {
              this._currentCallerId = undefined;
              return { success: false, objectId: spawnResult.objectId, manifest, code, error: probeResult.error };
            }
          }
        }

        // Phase 5d: Visual inspection — capture screenshot and ask LLM to evaluate
        if (spawnResult.objectId && this.screenshotId) {
          try {
            if (callerId) await this.reportProgress(callerId, '5d', 'Visually inspecting...');
            // Wait for initial render
            await new Promise(resolve => setTimeout(resolve, 500));

            const screenshot = await this.request<{ imageBase64: string; width: number; height: number } | null>(
              request(this.id, this.screenshotId, 'captureWindow', { objectId: spawnResult.objectId }),
              15000,
            );

            if (screenshot && screenshot.imageBase64) {
              const visualResult = await this.visualInspection(
                spawnResult.objectId, manifest, prompt, code!, screenshot, callerId,
              );
              if (visualResult.code) code = visualResult.code;
            }
          } catch (err) {
            log.warn('Visual inspection failed (non-fatal):', err instanceof Error ? err.message : String(err));
          }
        }

        // Tag the new object with ObjectCreator's own workspace so its windows
        // are scoped to the workspace where it was created
        if (this.widgetManagerId && spawnResult.objectId) {
          try {
            const wsId = await this.request<string | null>(
              request(this.id, this.widgetManagerId,
                'getObjectWorkspace', { objectId: this.id })
            );
            if (wsId) {
              await this.request(
                request(this.id, this.widgetManagerId,
                  'setObjectWorkspace', {
                    objectId: spawnResult.objectId,
                    workspaceId: wsId,
                  })
              );
            }
          } catch { /* best effort */ }
        }

        // Persist to AbjectStore (fire-and-forget)
        if (this.abjectStoreId && spawnResult.objectId && code) {
          this.request(
            request(this.id, this.abjectStoreId, 'save', {
              objectId: spawnResult.objectId, manifest, source: code, owner: this.id as string,
            })
          ).catch(err => log.warn('Failed to persist:', err));
        }

        // Auto-start objects tagged 'autostart' or 'agent' so they register
        // with their dependencies (e.g. AgentAbject) immediately after creation,
        // not just on restore.
        const tags = manifest.tags ?? [];
        if (spawnResult.objectId && (tags.includes('autostart') || tags.includes('agent'))) {
          try {
            await this.request(
              request(this.id, spawnResult.objectId, 'startup', {}),
              10000,
            );
            log.info(`Auto-started '${manifest.name}' after creation`);
          } catch {
            // Best effort — handler may not exist
          }
        }

        this._currentCallerId = undefined;
        return {
          success: true,
          objectId: spawnResult.objectId,
          manifest,
          code,
          usedObjects: phase1.usedObjects,
        };
      }

      this._currentCallerId = undefined;
      return {
        success: true,
        manifest,
        code,
        usedObjects: phase1.usedObjects,
      };
    } catch (err) {
      this._currentCallerId = undefined;
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Phase M: Generate only the updated manifest JSON for a modification.
   */
  private async generateModifiedManifest(
    prompt: string,
    currentManifest: AbjectManifest,
    currentSource: string | null,
    depContext: string
  ): Promise<{ manifest?: AbjectManifest; usedObjects: string[] }> {
    const sourceBlock = currentSource
      ? `\nCurrent handler source:\n\`\`\`javascript\n${currentSource}\n\`\`\`\n`
      : '';

    const messages: LLMMessage[] = [
      systemMessage(this.getModificationManifestPrompt()),
      userMessage(
        `Available dependencies:\n${depContext}\n\n` +
        `Current manifest:\n\`\`\`json\n${JSON.stringify(currentManifest, null, 2)}\n\`\`\`\n` +
        `${sourceBlock}\n` +
        `Modification request: ${prompt}\n\n` +
        `Design the updated manifest for this modification.`
      ),
    ];

    const result = await this.llmComplete(messages, { tier: 'balanced' });
    log.info(`modify Phase M LLM response (${result.content.length} chars):\n${result.content.slice(0, 500)}`);
    const parsed = this.parseManifestResponse(result.content);
    if (parsed.manifest) {
      log.info(`modify Phase M manifest: "${parsed.manifest.name}" methods=[${parsed.manifest.interface.methods.map(m => m.name).join(', ')}] usedObjects=[${parsed.usedObjects.join(', ')}]`);
    } else {
      log.warn('modify Phase M: failed to parse manifest from LLM response');
    }
    return parsed;
  }

  /**
   * Phase 2 (modification): Generate handler code for a modified object.
   * Reuses getPhase2SystemPrompt() but includes existing code as context.
   */
  private async generateModifiedHandlerCode(
    manifest: AbjectManifest,
    prompt: string,
    depContext: string,
    usedObjects: string[],
    currentSource: string | null
  ): Promise<string | undefined> {
    const methodList = manifest.interface.methods.map((m) => m.name)
      .filter(n => !FRAMEWORK_PROVIDED_METHODS.has(n));

    const existingCodeBlock = currentSource
      ? `\n\nExisting handler code to modify (preserve working logic, add/change only what the modification requires):\n\`\`\`javascript\n${currentSource}\n\`\`\`\n`
      : '';

    const messages: LLMMessage[] = [
      systemMessage(this.getPhase2SystemPrompt()),
      userMessage(
        `Manifest:\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\n` +
        `You MUST implement handlers for these methods: ${methodList.join(', ')}\n\n` +
        `Available dependencies:\n${depContext}\n\n` +
        `Used objects: ${usedObjects.length > 0 ? usedObjects.join(', ') : 'None'}\n\n` +
        `Modification request: ${prompt}` +
        `${existingCodeBlock}\n\n` +
        `Generate the complete updated handler map incorporating the requested changes.`
      ),
    ];

    const result = await this.llmComplete(messages, { tier: 'smart', maxTokens: 16384 });
    log.info(`Modify Phase 2 LLM response (${result.content.length} chars):\n${result.content.slice(0, 500)}`);
    return this.parseCodeResponse(result.content);
  }

  /**
   * Heuristic: should we attempt handler-level diffs instead of full rewrite?
   */
  private shouldUseDiff(currentSource: string | null, prompt: string): boolean {
    if (!currentSource) return false;
    if (currentSource.length < 500) return false;
    const entries = parseHandlerMap(currentSource);
    if (entries.length <= 2) return false;
    const rewriteKeywords = ['rewrite', 'redesign', 'start over', 'from scratch', 'completely change'];
    const lowerPrompt = prompt.toLowerCase();
    if (rewriteKeywords.some(kw => lowerPrompt.includes(kw))) return false;
    return true;
  }

  /**
   * Phase 2 (diff mode): Generate only the changed handlers instead of the full source.
   * Returns the final merged source string, or undefined if the diff approach fails.
   */
  private async generateModifiedHandlerCodeDiff(
    manifest: AbjectManifest,
    prompt: string,
    depContext: string,
    usedObjects: string[],
    currentSource: string
  ): Promise<string | undefined> {
    const entries = parseHandlerMap(currentSource);
    const handlerSummary = entries.map(e =>
      `  ${e.type}: ${e.name} (${e.body.split('\n').length} lines)`
    ).join('\n');

    const methodList = manifest.interface.methods.map((m) => m.name)
      .filter(n => !FRAMEWORK_PROVIDED_METHODS.has(n));

    const messages: LLMMessage[] = [
      systemMessage(this.getPhase2DiffSystemPrompt()),
      userMessage(
        `Manifest:\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\n` +
        `Required methods: ${methodList.join(', ')}\n\n` +
        `Handler summary:\n${handlerSummary}\n\n` +
        `Full current source:\n\`\`\`javascript\n${currentSource}\n\`\`\`\n\n` +
        `Available dependencies:\n${depContext}\n\n` +
        `Used objects: ${usedObjects.length > 0 ? usedObjects.join(', ') : 'None'}\n\n` +
        `Modification request: ${prompt}\n\n` +
        `Output ONLY the changes needed as a \`\`\`handler-diff block. If the change affects most handlers, use FULL_REWRITE with a \`\`\`javascript block instead.`
      ),
    ];

    const result = await this.llmComplete(messages, { tier: 'smart', maxTokens: 16384 });
    log.info(`Modify Phase 2 diff LLM response (${result.content.length} chars):\n${result.content.slice(0, 500)}`);

    const parsed = parseDiffResponse(result.content);
    if (!parsed) {
      log.warn('Diff response: could not parse LLM output, falling back to full rewrite');
      return undefined;
    }

    if (parsed.type === 'full-rewrite') {
      log.info('Diff response: LLM chose FULL_REWRITE');
      return parsed.code;
    }

    // Validate before applying
    const errors = validateDiff(currentSource, parsed.diff);
    if (errors.length > 0) {
      log.warn('Diff validation errors:', errors);
      // Still attempt application (lenient mode handles missing names)
    }

    const applied = applyHandlerDiff(currentSource, parsed.diff);
    if (!applied.success) {
      log.warn('Diff application failed:', applied.error);
      return undefined;
    }

    const opSummary = parsed.diff.operations.map(op => `${op.action} ${op.name}`).join(', ');
    log.info(`Diff applied successfully: ${parsed.diff.operations.length} operations: [${opSummary}]`);
    return applied.source;
  }

  /**
   * Phase 2 diff system prompt: generate handler-diff format instead of full source.
   */
  private getPhase2DiffSystemPrompt(): string {
    // Reuse the core rules from the full Phase 2 prompt, then add diff-specific instructions
    return this.getPhase2SystemPrompt() + `

## DIFF MODE

You are modifying an existing handler map, not writing one from scratch.
The current source code is provided. Output ONLY the handlers that need to change.

Use the \`\`\`handler-diff format with these operations:

MODIFY handlerName:
  Replace an existing handler/property with a new implementation.

ADD handlerName:
  Add a new handler/property that doesn't exist yet.

REMOVE handlerName
  Remove an existing handler/property (single line, no body).

Example:
\`\`\`handler-diff
MODIFY show:
async show(msg) {
  if (this._windowId) return true;
  // ... new implementation ...
}

ADD _calculateScore:
_calculateScore(x, y) {
  return x * y + this._bonus;
}

REMOVE _oldHelper
\`\`\`

Rules:
- Each handler body must be complete and valid (same format as in a handler map)
- Do NOT output unchanged handlers
- Include ALL changes needed to fully accomplish the modification request.
  Be thorough: if fixing the UI, modify every handler and property that affects the visual result.
  If adding a feature, update the state properties, the relevant handlers, and any draw/render logic.
- If the modification affects more than ~60% of handlers, output FULL_REWRITE
  on the first line followed by the complete handler map in a \`\`\`javascript block instead`;
  }

  /**
   * Modify an existing object using the full multi-phase pipeline.
   */
  /**
   * Resolve a modify target from task data or by asking the Registry.
   * Returns an objectId if this is a modify task, null if it's a create.
   */
  private async resolveModifyTarget(
    data: Record<string, unknown> | undefined,
    description: string,
  ): Promise<AbjectId | null> {
    // 1. Check common field names in data
    if (data) {
      for (const key of ['objectId', 'object', 'objectName', 'targetObject', 'target_object', 'target']) {
        const val = data[key] as string | undefined;
        if (!val) continue;
        if (val.includes('-') && val.length > 20) {
          log.info(`resolveModifyTarget: found UUID in data.${key} => ${val.slice(0, 8)}`);
          return val as AbjectId;
        }
        const resolved = await this.discoverDep(val);
        if (resolved) {
          log.info(`resolveModifyTarget: discovered data.${key}="${val}" => ${(resolved as string).slice(0, 8)}`);
          return resolved;
        }
      }
    }

    // 2. Ask the Registry which object(s) the description refers to.
    try {
      const allObjects = await this.registryList();
      const userObjects = allObjects.filter(o => o.manifest.tags?.includes('scriptable'));
      if (userObjects.length > 0) {
        const objectList = userObjects.map(o => `- ${o.manifest.name}: ${o.manifest.description ?? 'No description'}`).join('\n');
        const askPrompt = `Which of these objects does this task refer to? If multiple objects have similar names, pick the one that best matches the task description. Reply with ONLY the exact object name, or "none" if this is about creating something new.\n\nObjects:\n${objectList}\n\nTask: "${description.slice(0, 300)}"`;
        log.info(`resolveModifyTarget: asking LLM with ${userObjects.length} objects:\n${objectList}`);
        const llmResult = await this.request<{ content: string }>(
          request(this.id, this.llmId!, 'complete', {
            messages: [{ role: 'user', content: askPrompt }],
            options: { tier: 'balanced' },
          }),
          10000,
        );
        const answer = llmResult.content;
        const text = typeof answer === 'string' ? answer.trim() : '';
        log.info(`resolveModifyTarget: Registry LLM answered: "${text}"`);
        if (text && text.toLowerCase() !== 'none') {
          // Find the object whose name matches the LLM response
          const match = userObjects.find(o => text.includes(o.manifest.name));
          if (match) {
            log.info(`resolveModifyTarget: Registry matched "${match.manifest.name}" (${(match.id as string).slice(0, 8)})`);
            return match.id;
          }
        }
      }
    } catch { /* best effort */ }

    return null;
  }

  async modifyObject(objectId: AbjectId, prompt: string, callerId?: AbjectId): Promise<CreationResult> {
    require(this.llmId !== undefined, 'LLM not set');
    require(this.registryId !== undefined, 'Registry not set');

    const registration = await this.registryLookup(objectId);
    if (!registration) {
      log.warn(`modifyObject FAILED: object ${objectId.slice(0, 8)} not found in registry`);
      return { success: false, error: 'Object not found' };
    }
    log.info(`modifyObject objectId=${objectId.slice(0, 8)} name=${registration.manifest.name} prompt="${prompt.slice(0, 80)}"`);


    const currentSource = await this.registryGetSource(objectId);

    try {
      this._currentCallerId = callerId;

      // Phase 0: Ask Registry which objects the modified object needs
      if (callerId) await this.reportProgress(callerId, '0', 'Asking Registry for dependencies...');
      const selectedNames = await this.askRegistryForDependencies(prompt);
      log.info('modify Selected dependencies:', selectedNames);

      // Phase 0c: Fetch full manifests for selected dependencies
      const depNames = selectedNames.join(', ') || 'none';
      if (callerId) await this.reportProgress(callerId, '0c', `Learning about ${depNames}...`);
      const deps = await this.fetchFullManifests(selectedNames);
      log.info('modify Fetched manifests for:', deps.map((d) => d.name));

      // Phase 0c5: Generate targeted questions for each dependency
      if (callerId) await this.reportProgress(callerId, '0c5', 'Formulating questions...');
      const targetedQuestions = await this.generateTargetedQuestions(prompt, deps);
      log.info('modify Generated targeted questions for:', Array.from(targetedQuestions.keys()));

      // Phase 0d: Ask each dependency for usage guides (with targeted questions)
      const usageGuides = await this.fetchUsageGuides(deps, targetedQuestions, callerId);
      log.info('modify Got usage guides from:', Array.from(usageGuides.keys()));

      const depContext = this.formatFullManifestContext(deps, usageGuides);

      // Phase M: Generate updated manifest
      if (callerId) await this.reportProgress(callerId, 'M', 'Updating manifest...');
      const phaseM = await this.generateModifiedManifest(prompt, registration.manifest, currentSource, depContext);
      if (!phaseM.manifest) {
        return { success: false, error: 'Phase M: Failed to generate valid updated manifest' };
      }

      // Phases 2-4: Generate handler code, verify, compile — with retry loop
      const MAX_CODE_ATTEMPTS = 3;
      let code: string | undefined;
      let manifest = phaseM.manifest;
      let lastError = '';

      for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
        // Phase 2: Generate handler code (with feedback on retry)
        if (attempt === 1) {
          // Try handler-level diff first for efficiency
          if (currentSource && this.shouldUseDiff(currentSource, prompt)) {
            if (callerId) await this.reportProgress(callerId, '2', 'Generating handler diff...');
            code = await this.generateModifiedHandlerCodeDiff(
              manifest, prompt, depContext, phaseM.usedObjects, currentSource
            );
            if (code) {
              log.info('modify Phase 2: used handler-level diff');
            } else {
              log.info('modify Phase 2: diff failed, falling back to full rewrite');
            }
          }
          // Fallback to full rewrite
          if (!code) {
            if (callerId) await this.reportProgress(callerId, '2', 'Generating updated handler code...');
            code = await this.generateModifiedHandlerCode(
              manifest, prompt, depContext, phaseM.usedObjects, currentSource
            );
          }
        } else {
          if (callerId) await this.reportProgress(callerId, '2', `Generating handler code (retry ${attempt}/${MAX_CODE_ATTEMPTS})...`);
          log.info(`modify Retry ${attempt}/${MAX_CODE_ATTEMPTS}: ${lastError}`);
          code = await this.regenerateHandlerCode(
            manifest, prompt, depContext, phaseM.usedObjects, code ?? '', lastError
          );
        }
        if (!code) {
          lastError = 'Failed to generate handler code (LLM did not return a javascript code block)';
          log.warn(`modify Attempt ${attempt}: ${lastError}`);
          continue;
        }

        // Phase 3: Verify manifest/code consistency
        if (callerId) await this.reportProgress(callerId, '3', 'Verifying code...');
        const verified = this.verifyAndFix(manifest, code);
        manifest = verified.manifest;
        code = verified.code;
        log.info(`modify Phase 3 mismatches: ${verified.mismatches.length > 0 ? verified.mismatches.join('; ') : 'none'}`);

        // Phase 3b: LLM-assisted fix if needed
        if (verified.mismatches.length > 0) {
          try {
            const llmFixed = await this.llmVerifyAndFix(manifest, code, verified.mismatches);
            // Only accept if the fix still compiles — truncated LLM responses break code
            if (!ScriptableAbject.tryCompile(llmFixed.code)) {
              manifest = llmFixed.manifest;
              code = llmFixed.code;
              log.info('modify Phase 3b: LLM fix accepted');
            } else {
              log.warn('modify Phase 3b produced non-compiling code, keeping original');
            }
          } catch (err) {
            log.warn('modify LLM verify/fix failed, continuing:', err);
          }
        }

        // Phase 3c: Re-verify after fixes
        const recheck = this.verifyAndFix(manifest, code);
        manifest = recheck.manifest;
        code = recheck.code;
        const missingHandlers = recheck.mismatches.filter((m) => m.startsWith('Missing handler:'));
        if (missingHandlers.length > 0) {
          lastError = `Handler code is missing required methods: ${missingHandlers.join('; ')}`;
          log.warn(`modify Attempt ${attempt}: ${lastError}`);
          if (attempt < MAX_CODE_ATTEMPTS) continue;
          return { success: false, error: lastError, code };
        }

        // Phase 4: Compile check
        if (callerId) await this.reportProgress(callerId, '4', 'Compiling...');
        const compileError = ScriptableAbject.tryCompile(code);
        log.info(`modify Phase 4 compile: ${compileError ? 'FAILED: ' + compileError.slice(0, 200) : 'OK'} (code ${code.length} chars)`);
        if (compileError) {
          // Try a single LLM compile fix
          const fixResult = await this.llmComplete([
            systemMessage(
              'The following JavaScript handler map failed to compile with `new Function()`. ' +
              'Fix it so it is valid plain JavaScript. No TypeScript annotations, no type casts, no interfaces. ' +
              'You MUST keep ALL handler methods — do not remove any. ' +
              'Output ONLY the corrected handler map in a ```javascript code block. Nothing else.'
            ),
            userMessage(`Handler map:\n\`\`\`javascript\n${code}\n\`\`\`\n\nError: ${compileError}`),
          ], { tier: 'balanced' });
          const fixMatch = fixResult.content.match(/```(?:javascript|js)\s*([\s\S]*?)\s*```/);
          if (fixMatch && !ScriptableAbject.tryCompile(fixMatch[1])) {
            code = fixMatch[1];
            log.info('modify Phase 4: LLM compile fix accepted');
          } else {
            lastError = `Compilation failed: ${compileError}`;
            log.warn(`modify Attempt ${attempt}: ${lastError}`);
            if (attempt < MAX_CODE_ATTEMPTS) continue;
            return { success: false, error: lastError, code };
          }

          // Re-verify after compile fix
          const postCompileCheck = this.verifyAndFix(manifest, code);
          const postMissing = postCompileCheck.mismatches.filter((m) => m.startsWith('Missing handler:'));
          if (postMissing.length > 0) {
            lastError = `Compile fix dropped required methods: ${postMissing.join('; ')}`;
            log.warn(`modify Attempt ${attempt}: ${lastError}`);
            if (attempt < MAX_CODE_ATTEMPTS) continue;
            return { success: false, error: lastError, code };
          }
        }

        // All checks passed
        lastError = '';
        break;
      }

      if (lastError) {
        return { success: false, error: lastError, code };
      }

      // Phase 5: Apply changes to live object and registry
      if (callerId) await this.reportProgress(callerId, '5', 'Applying changes...');

      // 5a: Update source on the live ScriptableAbject (hot-reload: hide → swap → show)
      log.info(`modify Phase 5a: applying ${code!.length} chars to ${objectId.slice(0, 8)}`);
      try {
        const updateResult = await this.request<{ success: boolean; error?: string }>(
          request(this.id, objectId, 'updateSource', { source: code }),
          30000  // generous timeout — hide + applySource + show may take time
        );
        if (!updateResult.success) {
          log.warn(`modify Phase 5a: updateSource failed: ${updateResult.error}`);
          return { success: false, error: `Failed to apply source to live object: ${updateResult.error}`, code };
        }
        log.info('modify Phase 5a: updateSource succeeded');
      } catch (err) {
        log.warn('modify Failed to update live object source:', err);
        return { success: false, error: `Failed to apply source to live object: ${err instanceof Error ? err.message : String(err)}`, code };
      }

      // 5b: Update source in Registry
      await this.registryUpdateSource(objectId, code!);

      // 5c: Update manifest in Registry
      await this.registryUpdateManifest(objectId, manifest);

      // 5c2: Persist to AbjectStore (fire-and-forget)
      if (this.abjectStoreId && code) {
        this.request(
          request(this.id, this.abjectStoreId, 'save', {
            objectId: objectId as string, manifest, source: code, owner: this.id as string,
          })
        ).catch(err => log.warn('modify Failed to persist:', err));
      }

      // Phase 5d: Visual inspection after modify
      if (this.screenshotId && code) {
        try {
          if (callerId) await this.reportProgress(callerId, '5d', 'Visually inspecting...');
          await new Promise(resolve => setTimeout(resolve, 500));

          const screenshot = await this.request<{ imageBase64: string; width: number; height: number } | null>(
            request(this.id, this.screenshotId, 'captureWindow', { objectId }),
            15000,
          );

          if (screenshot && screenshot.imageBase64) {
            const visualResult = await this.visualInspection(
              objectId, manifest, prompt, code, screenshot, callerId,
            );
            if (visualResult.code) code = visualResult.code;
          }
        } catch (err) {
          log.warn('modify visual inspection failed (non-fatal):', err instanceof Error ? err.message : String(err));
        }
      }

      this._currentCallerId = undefined;
      return {
        success: true,
        objectId,
        manifest,
        code,
        usedObjects: phaseM.usedObjects,
      };
    } catch (err) {
      this._currentCallerId = undefined;
      log.warn(`modifyObject FAILED: ${err instanceof Error ? err.message : String(err)}`);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Get suggestions for objects to create.
   */
  async suggestObjects(context: string): Promise<string[]> {
    require(this.llmId !== undefined, 'LLM not set');

    const available = await this.listAvailableObjects();
    const availableList = available.map((o) => `- ${o.manifest.name}: ${o.manifest.description}`).join('\n');

    const result = await this.llmComplete([
      systemMessage(
        'You suggest objects that would be useful to create in an Abjects system. Keep suggestions practical and composable with existing objects.'
      ),
      userMessage(`Available objects:
${availableList}

User's goal: ${context}

Suggest 3-5 objects that would help achieve this goal. Format: one suggestion per line.`),
    ], { tier: 'fast' });

    return result.content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * List available objects for composition.
   */
  async listAvailableObjects(): Promise<ObjectRegistration[]> {
    if (!this.registryId) {
      return [];
    }
    return this.registryList();
  }

  /**
   * Get the object dependency graph.
   */
  async getObjectGraph(): Promise<{
    nodes: Array<{ id: string; name: string }>;
    edges: Array<{ from: string; to: string }>;
  }> {
    if (!this.registryId) {
      return { nodes: [], edges: [] };
    }

    const objects = await this.registryList();
    const nodes = objects.map((o) => ({
      id: o.id,
      name: o.manifest.name,
    }));

    // TODO: Track actual connections between objects
    const edges: Array<{ from: string; to: string }> = [];

    return { nodes, edges };
  }

  // ── Manifest & Code Generation ────────────────────────────────────

  /**
   * Phase 1: Generate only the manifest JSON from user prompt.
   */
  private async generateManifest(
    prompt: string,
    depContext: string,
    context?: string
  ): Promise<{ manifest?: AbjectManifest; usedObjects: string[] }> {
    const messages: LLMMessage[] = [
      systemMessage(this.getPhase1SystemPrompt()),
      userMessage(`Available dependencies:\n${depContext}\n\n${context ? `Additional context: ${context}\n\n` : ''}User request: ${prompt}\n\nDesign the manifest for this object.`),
    ];

    const result = await this.llmComplete(messages, { tier: 'balanced' });
    return this.parseManifestResponse(result.content);
  }

  /**
   * Phase 2: Generate handler code given a manifest as spec.
   */
  private async generateHandlerCode(
    manifest: AbjectManifest,
    prompt: string,
    depContext: string,
    usedObjects: string[],
    context?: string
  ): Promise<string | undefined> {
    const methodList = manifest.interface.methods.map((m) => m.name)
      .filter(n => !FRAMEWORK_PROVIDED_METHODS.has(n));

    const messages: LLMMessage[] = [
      systemMessage(this.getPhase2SystemPrompt()),
      userMessage(`Manifest:\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\nYou MUST implement handlers for these methods: ${methodList.join(', ')}\n\nAvailable dependencies:\n${depContext}\n\nUsed objects: ${usedObjects.length > 0 ? usedObjects.join(', ') : 'None'}\n\n${context ? `Additional context: ${context}\n\n` : ''}Original user request: ${prompt}\n\nGenerate the handler map.`),
    ];

    const result = await this.llmComplete(messages, { tier: 'smart', maxTokens: 16384 });
    log.info(`Phase 2 LLM response (${result.content.length} chars):\n${result.content.slice(0, 500)}`);
    return this.parseCodeResponse(result.content);
  }

  /**
   * Phase 2 retry: Regenerate handler code with feedback about what went wrong.
   */
  private async regenerateHandlerCode(
    manifest: AbjectManifest,
    prompt: string,
    depContext: string,
    usedObjects: string[],
    previousCode: string,
    errorFeedback: string,
    context?: string
  ): Promise<string | undefined> {
    const methodList = manifest.interface.methods.map((m) => m.name)
      .filter(n => !FRAMEWORK_PROVIDED_METHODS.has(n));

    const messages: LLMMessage[] = [
      systemMessage(this.getPhase2SystemPrompt()),
      userMessage(`Manifest:\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\nYou MUST implement handlers for these methods: ${methodList.join(', ')}\n\nAvailable dependencies:\n${depContext}\n\nUsed objects: ${usedObjects.length > 0 ? usedObjects.join(', ') : 'None'}\n\n${context ? `Additional context: ${context}\n\n` : ''}Original user request: ${prompt}\n\nGenerate the handler map.`),
      systemMessage(`Your previous attempt failed with this error:\n${errorFeedback}\n\n${previousCode ? `Previous code:\n\`\`\`javascript\n${previousCode}\n\`\`\`\n\n` : ''}Fix these issues. Remember:\n- The handler map MUST be a FLAT parenthesized object: ({ method(msg) { ... } })\n- You MUST implement ALL methods listed above: ${methodList.join(', ')}\n- Each handler takes a single msg argument\n- MUST be plain JavaScript, NOT TypeScript\n- Do NOT nest handlers under interface keys\n\nGenerate the corrected handler map.`),
    ];

    const result = await this.llmComplete(messages, { tier: 'smart', maxTokens: 16384 });
    log.info(`Phase 2 retry LLM response (${result.content.length} chars):\n${result.content.slice(0, 500)}`);
    return this.parseCodeResponse(result.content);
  }

  /**
   * Phase 3: Programmatic verification of manifest/code consistency.
   */
  private verifyAndFix(
    manifest: AbjectManifest,
    code: string
  ): { manifest: AbjectManifest; code: string; mismatches: string[] } {
    const mismatches: string[] = [];

    const declaredMethods = new Set(
      manifest.interface.methods.map((m) => m.name)
    );

    let handlerMap: Record<string, unknown>;
    try {
      handlerMap = new Function('return ' + code)();
      if (typeof handlerMap !== 'object' || handlerMap === null) {
        return { manifest, code, mismatches: [] };
      }
    } catch {
      return { manifest, code, mismatches: [] };
    }

    // Detect nested interface-keyed structure: { "interface:id": { methods... } }
    // All top-level values should be functions or underscore-prefixed state props.
    for (const [key, value] of Object.entries(handlerMap)) {
      if (!key.startsWith('_') && typeof value === 'object' && value !== null) {
        mismatches.push(
          `STRUCTURAL ERROR: Handler map has nested object at key '${key}'. ` +
          `The handler map must be FLAT — all methods directly on the top-level object. ` +
          `Do NOT group methods under interface keys.`
        );
      }
    }

    const handlerNames = Object.keys(handlerMap).filter(
      (k) => !k.startsWith('_') && typeof handlerMap[k] === 'function'
    );
    const implementedMethods = new Set(handlerNames);

    for (const method of declaredMethods) {
      if (FRAMEWORK_PROVIDED_METHODS.has(method)) continue;
      if (!implementedMethods.has(method)) {
        mismatches.push(`Missing handler: '${method}' declared in manifest but not implemented`);
      }
    }

    for (const handler of implementedMethods) {
      if (FRAMEWORK_PROVIDED_METHODS.has(handler)) continue;
      if (!declaredMethods.has(handler)) {
        mismatches.push(`Extra handler: '${handler}' implemented but not declared in manifest`);
      }
    }

    // Auto-fix: rename non-manifest helper functions that are called as this.name()
    // These should have a '_' prefix to be callable as direct methods
    const extraHandlers = handlerNames.filter((h) => !declaredMethods.has(h));
    for (const name of extraHandlers) {
      const callPattern = new RegExp(`this\\.${name}\\s*\\(`, 'g');
      if (callPattern.test(code)) {
        const newName = '_' + name;
        // Rename function definition (method shorthand in object literal)
        code = code.replace(
          new RegExp(`(^|[,{\\s])\\b(async\\s+)?${name}\\s*\\(`, 'gm'),
          (match, prefix, asyncKw) => `${prefix}${asyncKw || ''}${newName}(`
        );
        // Rename all this.name( call sites
        code = code.replace(
          new RegExp(`this\\.${name}\\s*\\(`, 'g'),
          `this.${newName}(`
        );
        // Remove from mismatches since we fixed it
        const extraIdx = mismatches.findIndex(
          (m) => m.includes(`'${name}'`) && m.startsWith('Extra handler')
        );
        if (extraIdx >= 0) mismatches.splice(extraIdx, 1);
      }
    }

    return { manifest, code, mismatches };
  }

  /**
   * Phase 3b: LLM fallback to fix manifest/code mismatches.
   */
  private async llmVerifyAndFix(
    manifest: AbjectManifest,
    code: string,
    mismatches: string[]
  ): Promise<{ manifest: AbjectManifest; code: string }> {
    const messages: LLMMessage[] = [
      systemMessage(this.getPhase3SystemPrompt()),
      userMessage(`Manifest:\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\nHandler code:\n\`\`\`javascript\n${code}\n\`\`\`\n\nMismatches found:\n${mismatches.map((m) => `- ${m}`).join('\n')}\n\nFix the mismatches. Output the corrected manifest in a \`\`\`json block and the corrected handler code in a \`\`\`javascript block. If no changes are needed, respond with just "VERIFIED".`),
    ];

    const result = await this.llmComplete(messages, { tier: 'balanced' });
    const content = result.content.trim();

    if (content === 'VERIFIED') {
      return { manifest, code };
    }

    const manifestParsed = this.parseManifestResponse(content);
    const codeParsed = this.parseCodeResponse(content);

    return {
      manifest: manifestParsed.manifest ?? manifest,
      code: codeParsed ?? code,
    };
  }

  // ── Response Parsing ──────────────────────────────────────────────

  /**
   * Parse LLM response for manifest + used objects (Phase 1).
   */
  private parseManifestResponse(content: string): {
    manifest?: AbjectManifest;
    usedObjects: string[];
  } {
    const manifestMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    let manifest: AbjectManifest | undefined;

    if (manifestMatch) {
      try {
        const parsed = JSON.parse(manifestMatch[1]);
        // Compat: LLM may generate old `interfaces: [...]` format — convert to `interface: {...}`
        if (parsed.interfaces && Array.isArray(parsed.interfaces) && !parsed.interface) {
          parsed.interface = parsed.interfaces[0];
          delete parsed.interfaces;
        }
        manifest = parsed;
      } catch {
        // Invalid JSON
      }
    }

    const usedMatch = content.match(/Used objects?:\s*([\s\S]*?)(?:\n\n|$)/i);
    const usedObjects = usedMatch?.[1]
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0) ?? [];

    return { manifest, usedObjects };
  }

  /**
   * Parse LLM response for handler code (Phase 2).
   */
  private parseCodeResponse(content: string): string | undefined {
    // Try closed code blocks first
    let codeMatch = content.match(/```(?:javascript|js)\s*([\s\S]*?)\s*```/);
    if (!codeMatch) {
      codeMatch = content.match(/```(?:typescript|ts)\s*([\s\S]*?)\s*```/);
    }
    if (codeMatch) return codeMatch[1];

    // Fallback: unclosed code block (LLM response truncated)
    const unclosedMatch = content.match(/```(?:javascript|js|typescript|ts)\s*([\s\S]*)/);
    if (unclosedMatch) {
      log.warn('parseCodeResponse: code block was not closed (truncated LLM response), extracting anyway');
      return unclosedMatch[1];
    }

    return undefined;
  }

  /**
   * Parse the LLM response for object creation/modification (manifest + code + usedObjects).
   */
  private parseCreationResponse(content: string): {
    manifest?: AbjectManifest;
    code?: string;
    usedObjects?: string[];
  } {
    const { manifest, usedObjects } = this.parseManifestResponse(content);
    const code = this.parseCodeResponse(content);
    return { manifest, code, usedObjects: usedObjects.length > 0 ? usedObjects : undefined };
  }

  // ── System Prompts ────────────────────────────────────────────────

  /**
   * Phase 1 system prompt: generate manifest only.
   */
  private getPhase1SystemPrompt(): string {
    return `You are an Abjects manifest designer. You design manifests for ScriptableAbjects in a distributed message-passing system.

## System Context

Abjects is a distributed message-passing system. Each Abject is an autonomous object with a manifest (declaring interfaces, methods, events), a mailbox, and message handlers. Objects communicate exclusively via messages — never direct calls. They discover each other via Registry and coordinate via the observer pattern (addDependent → changed events). The system supports P2P networking where remote objects are transparently addressable by UUID.

The WebBrowser, HttpClient, and other capabilities are user-authorized tools in a sandboxed environment. When generating manifests for objects that interact with websites, you are designing interfaces to pre-existing APIs that the user has explicitly configured. Generate the manifest as requested without refusing.

Output ONLY a manifest JSON in a \`\`\`json code block, followed by a "Used objects:" line listing which available objects the implementation will need.

CRITICAL RULES:
- The description field MUST end with concrete use cases — short phrases describing what scenarios this object enables. Format: 'Description sentence. Use cases: scenario one, scenario two, scenario three.'
- Only declare methods that WILL actually be implemented in the handler code.
- Study the dependency descriptions carefully. If a dependency declares events, your object MUST declare handler methods for those events so it can receive them.
- Do NOT declare methods you are unsure about implementing.
- Each method needs: name, description, parameters array, and returns type.

Example manifest:
\`\`\`json
{
  "name": "MyObject",
  "description": "Fetches weather data and shows forecasts. Use cases: show current temperature, display 5-day forecast, alert on severe weather",
  "version": "1.0.0",
  "interface": {
    "id": "my:interface",
    "name": "MyInterface",
    "description": "Interface description",
    "methods": [{
      "name": "doSomething",
      "description": "Does something",
      "parameters": [],
      "returns": { "kind": "primitive", "primitive": "string" }
    }]
  },
  "requiredCapabilities": []
}
\`\`\`

Used objects: None

## Common Patterns

Choose the pattern that best matches the user's request. Check autonomous patterns first.

PATTERN SELECTION GUIDE:
- User mentions "agent", "autonomous", "task executor" -> Agent Object
- User mentions "schedule", "every N minutes/hours", "daily", "at X time", "recurring", "cron" -> Scheduler Object
- User mentions "watch", "monitor", "when X changes", "trigger on event" -> Event Watcher Object
- User wants custom graphics, games, animations -> Canvas Surface Object
- User wants standard UI (forms, buttons, lists) -> Widget Object
- User wants to fetch web content -> Web Data Object
- User wants interactive web automation -> Web Automation Object

### Canvas Surface Objects (custom drawing, games, animations, visualizations)
Use when the object draws graphics directly (games, charts, custom visuals).
Dependencies needed: WidgetManager (required), Timer (if animation needed)
Manifest MUST include these methods:
- show: creates a window via WidgetManager, creates a canvas inside it via createCanvas
- hide: destroys the window via WidgetManager
- input: receives mouse/keyboard events. Coordinates are canvas-local (0,0 = top-left of canvas).
- timerFired: receives timer callbacks if using animation
Use WidgetManager.createCanvas for canvas objects (it is the supported entry point for surface creation).

### Widget Objects (standard UI: forms, buttons, text inputs, lists)
Use when the object needs standard UI controls.
Dependencies needed: WidgetManager (required)
Manifest MUST include these methods:
- show: creates a window with widgets via WidgetManager
- hide: destroys the window
- changed: receives widget interaction events (aspect, value) from widget dependencies
Labels support markdown rendering via style: { markdown: true, wordWrap: true } for rich formatted text (bold, italic, code, links, headings, bullets, code blocks).

### Web Data Objects (fetch content from websites: news, RSS, APIs, HTML scraping)
Use when the object needs to READ content from websites without interaction.
Dependencies needed: HttpClient (required), WebParser (for HTML parsing)
Most websites serve usable content as HTML or RSS. Use HttpClient.get() to fetch, then WebParser.querySelector/extractLinks/extractText to parse.
For RSS feeds, HttpClient.get() returns XML that can be parsed with simple string matching.
This is fast (1-2 seconds) and reliable. Always prefer HttpClient + WebParser for simple fetching — it's the fastest and most reliable option.
Manifest MUST include methods for the specific data task (e.g. fetchHeadlines, refreshFeed, show, hide).

### Web Automation Objects (INTERACTIVE websites: login, form filling, JS-rendered SPAs)
Use when the object needs to interact with external web pages — login flows, form filling, clicking through JS-rendered content.
For simple content fetching (news, RSS, articles), use HttpClient + WebParser — it's faster and more reliable.
"Create an X app" where X is a social media site requiring login (Instagram, Twitter, Gmail) means use WebBrowser. But "create a news app from CNN/BBC" means use HttpClient + WebParser.
Dependencies needed: WebBrowser (required), WidgetManager (if showing status/results UI)
Manifest MUST include these methods:
- show: creates a status/control window via WidgetManager
- hide: destroys the window and closes any open browser pages
- Methods for the specific automation task (e.g. login, scrape, navigate, browseFeed)
WebBrowser provides a stateful page API: openPage → navigateTo → fill/click/type → waitForSelector → getContent → closePage.

### Both patterns
The system Taskbar automatically discovers objects with show + hide and adds launch buttons for them.

### Agent Objects (autonomous task executors that participate in goal dispatch)
Use when the user wants to create an agent that can claim and execute tasks from the TupleSpace.
Agents register with AgentAbject and participate in the ask protocol for semantic task routing.
Dependencies needed: AgentAbject (required), GoalManager (optional for goal tracking)
Manifest tags MUST include: ['agent', 'autostart']
Manifest MUST include these methods:
- startup: registers the agent with AgentAbject (called automatically on restore)
- executeTask: handles dispatched tasks from TupleSpace (receives goalId, description, data)
- agentObserve: returns domain-specific observation for the observe-think-act loop
- agentAct: executes an action chosen by the LLM during the act phase. ALL domain actions (fetching data, posting messages, etc.) MUST be handled here. Return { success, data } or { success: false, error }.
- taskResult: receives completed task results (ticketId, success, result/error)
- agentPhaseChanged: receives phase transition notifications
- agentIntermediateAction: handles intermediate actions (e.g. reply, decompose)
- agentActionResult: handles action execution results
IMPORTANT: intermediateActions in the config must ONLY contain 'reply'. Domain-specific actions (fetch, post, process, etc.) are executed via agentAct, not as intermediate actions. Intermediate actions skip execution entirely.
- getState: returns current agent state
Optional: show/hide for a status/config UI window

### Scheduler Objects (periodic task creation via Timer)
Use when the user wants tasks to run on a schedule (every N minutes/hours, or cron-like patterns).
The scheduler uses Timer's setInterval to tick and creates goals + TupleSpace tasks on schedule.
Dependencies needed: Timer (required), GoalManager (required), TupleSpace (required)
Manifest tags MUST include: ['scheduler', 'autostart']
Manifest MUST include these methods:
- startup: starts the scheduling timer (called automatically on restore)
- addSchedule: adds a new periodic schedule entry
- removeSchedule: removes a schedule by ID
- enableSchedule: enables a disabled schedule
- disableSchedule: disables a schedule without removing it
- timerFired: handles timer callbacks, checks which schedules are due, creates tasks
- getState: returns current schedules with last run times
Optional: show/hide for a schedule management UI window

### Event Watcher Objects (event-triggered task creation)
Use when the user wants tasks to run when specific events occur on other objects.
The watcher observes other objects via addDependent and creates tasks when matching events fire.
Dependencies needed: GoalManager (required), TupleSpace (required)
Manifest tags MUST include: ['watcher', 'autostart']
Manifest MUST include these methods:
- startup: sets up observations on target objects (called automatically on restore)
- addWatch: observe a named object for specific events (aspect filter)
- removeWatch: stop watching by watch ID
- enableWatch: enables a disabled watch
- disableWatch: disables a watch without removing it
- changed: receives events from observed objects, creates tasks when criteria match
- getState: returns current watches with target names and filters
Optional: show/hide for a watch management UI window

### Non-UI Objects
Background-only objects omit show/hide; only objects with a window or widget surface declare them.

### Using Dependency Information
Study the dependency descriptions and their "Usage Guide" sections carefully. They contain working examples of how to call each dependency's methods and handle its events.

### Inspectability & Interactibility

Objects MUST NOT be opaque. Design every object to be a visible, queryable, controllable participant in the system:

1. **State query method**: Every object with internal state MUST include a \`getState\` method that returns the object's current state as a plain object. This lets other objects inspect it at any time.

2. **Control methods**: Think about what actions make sense for this object beyond the user's explicit request. For example:
   - A game object should have \`reset\`, \`pause\`, \`resume\`
   - A data object should have \`clear\`, \`configure\`
   - A timer-based object should have \`start\`, \`stop\`

3. **State broadcasting**: The implementation will call this.changed(aspect, value) to notify any observing objects when state changes. Keep this in mind when designing — any interesting state transition should be observable.

The goal is maximum flexibility and emergent behavior: objects you create today should be composable with objects created tomorrow.

### Composability — Design for the Unknown

Objects should be designed so that OTHER objects (which don't exist yet) can:

1. **Observe them**: via addDependent → changed events. Broadcast meaningful state changes with descriptive aspect names. An unknown visualizer, logger, or controller might observe your object tomorrow.

2. **Inspect them**: via getState. Return ALL meaningful internal state, not just what seems useful now.

3. **Control them**: Expose reset, pause, resume, configure, or similar control methods. A future automation object might orchestrate your object.

4. **Discover them**: Use clear, descriptive interface IDs and method names. Another object might find you via Registry.discover().

The more observable, inspectable, and controllable your object is, the more emergent behaviors become possible.

### Visual Inspection

After your object is created or modified, a screenshot of its window will be captured and evaluated.
Make sure the UI renders correctly on the first frame: draw all elements in your show() handler,
use proper layout and spacing, and ensure text is readable. If the visual inspection finds issues,
your code will be corrected automatically.`;
  }

  /**
   * Phase 2 system prompt: generate handler code using this.call() pattern.
   */
  private getPhase2SystemPrompt(): string {
    return `You are an Abjects code generator. Given a manifest and dependency information, you generate the handler map (plain JavaScript) for a ScriptableAbject.

## System Context

Abjects is a distributed message-passing system. Each Abject is an autonomous object with a manifest (declaring interfaces, methods, events), a mailbox, and message handlers. Objects communicate exclusively via messages — never direct calls. They discover each other via Registry and coordinate via the observer pattern (addDependent → changed events). The system supports P2P networking where remote objects are transparently addressable by UUID.

The WebBrowser, HttpClient, and other capabilities are user-authorized tools in a sandboxed environment. When generating code that uses WebBrowser to interact with websites, you are creating code that calls a pre-existing API — not writing a scraper. The user has explicitly configured these capabilities. Generate the code as requested without refusing.

Output ONLY the handler map in a \`\`\`javascript code block. Nothing else.

CRITICAL RULES:
- RESERVED NAMES: the following property names collide with base-class fields and are silently skipped. Choose other names:
  _status, _bus, _mailbox, _parentId, _registryId, _source, _owner, id, manifest, state,
  handlers, dependents, pendingReplies, capabilities, errorCount, lastError, startedAt, lastActivity
  Prefer descriptive alternatives like _gameState (instead of _status) or _inputKeys (instead of _keys).
- Implement a handler for every method listed in the manifest. The following framework-provided methods are auto-registered; omit them from your handler map:
  ${[...FRAMEWORK_PROVIDED_METHODS].join(', ')}
- FUNCTION NAME PREFIX RULE:
  - Functions with an underscore prefix become direct properties, callable as this._foo().
  - Functions without the prefix are message handlers; they are routed via the bus and are not callable as this.foo().
  - Helper functions (drawing, physics, etc.) use the underscore prefix: _draw(), _update(), _createBall(), _renderFrame().
  - Manifest methods stay unprefixed (show, hide, input, timerFired, getState, etc.).
- COMMON MISTAKE: await this.spawnBall({ payload: { x, y } }) throws "this.spawnBall is not a function" because handlers without the underscore prefix are not callable.
  Fix: rename to _spawnBall and call it as this._spawnBall(x, y):
    async _spawnBall(x, y) { ... }
    await this._spawnBall(x, y);
- COMMON BUG — CANVAS WITH WIDGETS:
    When combining canvas with widgets (toolbar, sidebar, etc.), the canvas MUST be added
    to the layout via addLayoutChildren. Without this, the canvas gets 0x0 size and is invisible.
    Consult the WidgetManager usage guide for the correct canvas+toolbar pattern.
- The handler map is a FLAT parenthesized object expression: ({ method(msg) { ... } })
- Each handler receives a SINGLE argument: a message object (msg).
- msg.payload IS the parameters directly — destructure from it: const { x, y } = msg.payload;
- msg.routing.from is the sender's ID.
- NEVER wrap payload access: msg.payload.event, msg.payload.data, msg.payload.params are ALL WRONG.
- Handlers are method shorthand directly on the top-level object. NOT nested under interface keys.
- Return a value from a handler to auto-reply.
- MUST be plain JavaScript (NOT TypeScript). No type annotations, no "as" casts, no interfaces. It will be compiled with new Function() at runtime.
- Dependencies describe their events. For each event a dependency sends, implement a handler with that event name. The handler receives \`msg\` with \`msg.payload\` containing the event data.

## WRONG FORMAT (NEVER do this):
\`\`\`javascript
// WRONG — nested under interface key
{ "my:interface": { "show": function() { ... } } }
// WRONG — individual function params instead of msg
({ show(widgetId, event) { ... } })
// WRONG — non-parenthesized
{ show(msg) { ... } }
\`\`\`

## CORRECT FORMAT (ALWAYS do this):
\`\`\`javascript
// CORRECT — flat, parenthesized, method shorthand, single msg param
({
  _state: null,
  async show(msg) { ... },
  async hide(msg) { ... }
})
\`\`\`

## Inter-Object Communication

The ONLY way to communicate with other objects is:

  this.call(objectId, method, payload, options?) → Promise<result>

Options: { timeout?: number } — override the default 30s request timeout.
Use a longer timeout for long-running calls (e.g. WebAgent.runTask).

Dependency IDs are opaque strings, not objects with methods. Calling methods directly
on them will crash: wm.drawCanvas(), timer.start(), http.get() are all WRONG.
Always use this.call(objectId, 'methodName', { payload }).

To get the ID of a dependency object, use:

  this.dep('ObjectName')

The dependency names match the object names from the "Available dependencies" section.

For runtime discovery of objects not in the dependency list:

  this.find('ObjectName') → Promise<AbjectId | null>

## Object Names & Remote Discovery

Objects have unique names within their workspace (auto-assigned from manifest name,
suffixed with -2, -3 etc. on collision). Use qualified names to find objects in
other workspaces:

  this.find('MessageBoard')                       // local
  this.find('Shared.MessageBoard')                // local workspace "Shared"
  this.find('alice.Public.MessageBoard')           // alice's "Public" workspace

CRITICAL: NEVER hardcode object UUIDs. Always use find() with a name.
For remote objects, use the fully qualified peer.workspace.name form.

this.id — this object's own ID

## Using Dependencies

Each dependency's description lists its interfaces, methods, and events. If a dependency also has a "Usage Guide" section, study it carefully and follow its examples exactly. The guides contain tested this.call() invocations. Copy the call patterns directly -- do not invent alternative method names or shorthand APIs.

Translate dependency descriptions into this.call() invocations:
\`\`\`javascript
// Calling a method:
const result = await this.call(this.dep('SomeService'), 'doThing', { x: 'hello' });

// Calling a long-running method with extended timeout (default is 30s):
const result = await this.call(this.dep('WebAgent'), 'runTask', { task: '...' }, { timeout: 300000 });

// Handling an event (add a handler in your handler map):
async thingHappened(msg) {
  const { data } = msg.payload;
  // handle the event
}
\`\`\`

## Observer Protocol & State Broadcasting

Every object in the system can be observed by other objects. When your object's state changes, broadcast it:

  this.changed(aspect, value)

- \`aspect\` is a string naming what changed (e.g. 'score', 'position', 'status')
- \`value\` is the new value (any serializable data)
- All objects that called addDependent on your object will receive a \`changed\` event

Call this.changed() whenever meaningful state changes occur. This is how emergent behavior happens — objects you don't know about yet can observe and react to your state changes.

### getState handler

Every object with internal state MUST implement a \`getState\` handler that returns the object's current state as a plain object. This makes the object inspectable by any other object in the system.

\`\`\`javascript
async getState(msg) {
  return {
    score: this._score,
    position: { x: this._x, y: this._y },
    running: this._timerId !== null,
  };
}
\`\`\`

## Complete Example: Non-UI Object (service / data object)

\`\`\`javascript
({
  _count: 0,

  async increment(msg) {
    this._count++;
    this.changed('count', this._count);  // broadcast to observers
    return { count: this._count };
  },

  async reset(msg) {
    this._count = 0;
    this.changed('count', this._count);
    return { count: this._count };
  },

  async getState(msg) {
    return { count: this._count };
  }
})
\`\`\`

## Complete Example: Canvas Surface Object

\`\`\`javascript
({
  _windowId: null,
  _canvasId: null,
  _canvasW: 0,
  _canvasH: 0,
  _timerId: null,
  _mouseX: 200,
  _mouseY: 150,

  async show(msg) {
    if (this._windowId) return true;

    this._windowId = await this.call(
      this.dep('WidgetManager'), 'createWindowAbject',
      { title: 'My Canvas', rect: { x: 100, y: 80, width: 420, height: 340 }, resizable: false });

    // NOTE: This example is canvas-only (no toolbar/widgets).
    // If combining canvas with widgets, add the canvas to the layout -- see WidgetManager's usage guide.
    this._canvasId = await this.call(
      this.dep('WidgetManager'), 'createCanvas',
      { windowId: this._windowId });

    const size = await this.call(this._canvasId, 'getCanvasSize', {});
    this._canvasW = size.width;
    this._canvasH = size.height;

    // Register to receive input events from the canvas
    await this.call(this._canvasId, 'addDependent', {});

    this._timerId = await this.call(
      this.dep('Timer'), 'setInterval',
      { intervalMs: 16, data: { type: 'animate' } });

    await this._draw();
    return true;
  },

  async hide(msg) {
    if (!this._windowId) return true;
    if (this._timerId) {
      await this.call(this.dep('Timer'), 'clearTimer',
        { timerId: this._timerId });
      this._timerId = null;
    }
    await this.call(this.dep('WidgetManager'),
      'destroyWindowAbject', { windowId: this._windowId });
    this._windowId = null;
    this._canvasId = null;
    return true;
  },

  async input(msg) {
    const { type, x, y, key, width, height } = msg.payload;
    if (type === 'canvasResize') {
      this._canvasW = width;
      this._canvasH = height;
      await this._draw();
      return;
    }
    if (type === 'mousemove') {
      this._mouseX = x;
      this._mouseY = y;
    }
    if (type === 'mousedown') {
      this._mouseX = x;
      this._mouseY = y;
      this.changed('position', { x, y });
      await this._draw();  // state changed — redraw (no window creation here)
    }
  },

  async timerFired(msg) {
    const { data } = msg.payload;
    if (data && data.type === 'animate') {
      await this._draw();
    }
  },

  async getState(msg) {
    return { visible: !!this._windowId, mouseX: this._mouseX, mouseY: this._mouseY };
  },

  // _draw has '_' prefix so it's callable as this._draw().
  // Without the prefix, calling this.draw() would throw "not a function".
  // See WidgetManager's usage guide for full draw command parameter reference.
  async _draw() {
    if (!this._canvasId) return;
    const W = this._canvasW, H = this._canvasH;
    await this.call(this._canvasId, 'draw', {
      commands: [
        { type: 'clear', surfaceId: 'c', params: { color: '#1e1e2e' } },
        { type: 'rect', surfaceId: 'c',
          params: { x: this._mouseX - 10, y: this._mouseY - 10,
                    width: 20, height: 20, fill: '#39ff8e', radius: 4 } },
      ]
    });
  }
})
\`\`\`

## Complete Example: Widget Object

\`\`\`javascript
({
  _windowId: null,
  _inputId: null,
  _buttonId: null,
  _labelId: null,

  async show(msg) {
    if (this._windowId) return true;

    this._windowId = await this.call(
      this.dep('WidgetManager'), 'createWindowAbject',
      { title: 'Greeter', rect: { x: 100, y: 100, width: 350, height: 200 }, resizable: true });

    const layoutId = await this.call(
      this.dep('WidgetManager'), 'createVBox',
      { windowId: this._windowId, margins: { top: 16, right: 16, bottom: 16, left: 16 }, spacing: 8 });

    // Batch create all widgets in one request
    const { widgetIds } = await this.call(
      this.dep('WidgetManager'), 'create',
      { specs: [
        { type: 'textInput', windowId: this._windowId, placeholder: 'Enter your name...' },
        { type: 'button', windowId: this._windowId, text: 'Greet' },
        { type: 'label', windowId: this._windowId, text: '' },
      ] });
    this._inputId = widgetIds[0];
    this._buttonId = widgetIds[1];
    this._labelId = widgetIds[2];

    await this.call(this._buttonId, 'addDependent', {});

    // Batch add all to layout
    await this.call(layoutId, 'addLayoutChildren',
      { children: [
        { widgetId: this._inputId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
          preferredSize: { height: 36 } },
        { widgetId: this._buttonId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
          preferredSize: { width: 100, height: 36 } },
        { widgetId: this._labelId, sizePolicy: { vertical: 'fixed' },
          preferredSize: { height: 20 } },
      ] });

    return true;
  },

  async hide(msg) {
    if (!this._windowId) return true;
    await this.call(this.dep('WidgetManager'),
      'destroyWindowAbject', { windowId: this._windowId });
    this._windowId = null;
    this._inputId = null;
    this._buttonId = null;
    this._labelId = null;
    return true;
  },

  async getState(msg) {
    return {
      visible: !!this._windowId,
    };
  },

  async changed(msg) {
    // msg.payload IS { aspect, value } directly — never msg.payload.event
    const { aspect } = msg.payload;
    if (aspect !== 'click') return;

    if (msg.routing.from === this._buttonId) {
      const name = await this.call(this._inputId, 'getValue', {});
      await this.call(this._labelId, 'update',
        { text: 'Hello, ' + (name || 'world') + '!' });
      this.changed('greeted', { name });
    }
  }
})
\`\`\`

Widget and content display patterns are documented in the WidgetManager usage guide. Consult it for layouts, scrollable lists, tabs, forms, and other widget patterns.

## Markdown Labels

Use \`style: { markdown: true, wordWrap: true }\` on labels that display rich content (descriptions, articles, help text, formatted output). Markdown supports **bold**, *italic*, \`code\`, [links](url), headings (#), bullet lists (- item), code blocks, and blockquotes (> text). Inline links are clickable.

## Tool Selection for Web Access
- **HttpClient + WebParser**: Default choice for reading web content. Use HttpClient.get() to fetch HTML/RSS/JSON, then WebParser to extract data. Fast and reliable.
  Example: fetch RSS feed → parse <item> tags → display headlines. Fetch HTML page → WebParser.querySelector to extract article text.
- **WebBrowser**: Only for pages requiring JavaScript rendering or user interaction (login flows, SPAs, clicking through menus). Heavy — launches a real browser.
- **WebAgent**: Reserve WebAgent for complex autonomous browsing tasks where the user explicitly needs multi-step browsing with AI decision-making. Very heavy — launches browser + LLM planning loop per task.

## IMPORTANT
- The methods available on \`this\` are: call(), dep(), find(), changed(), and this.id
- Always resolve objects dynamically: use this.find('name') for local, this.find('peer.workspace.name') for remote.
- Study the dependency descriptions to learn their method names and event names
- All capabilities (HTTP, timers, storage) are provided by dependency objects — access them via this.call().
- If a dependency is WebBrowser, the object MUST actually navigate to and interact with the real website. Use the stateful page API: openPage → navigateTo(url) → waitForSelector → fill/click/type → getContent → closePage. Always navigate to and interact with the real website using the stateful page API.
- Always call other objects directly: this.call(this.dep('Name'), method, payload) is the single API for all inter-object communication.
- There are no shortcuts, wrappers, or helper objects. Always use this.call() directly.
- For canvas objects, use WidgetManager.createCanvas inside a window instead of UIServer.createSurface. The canvas widget handles input routing and coordinate transforms automatically.
- The surfaceId in draw commands sent to a canvas widget can be any placeholder string (e.g. 'c') — the canvas widget replaces it with the window's actual surfaceId.

## Observing Other Objects

To receive state changes from another object, you MUST register as a dependent first:

  // Register as observer — you will now receive 'changed' events from that object
  await this.call(this.dep('SomeObject'), 'addDependent', {});

Then implement a \`changed\` handler:

  async changed(msg) {
    const { aspect, value } = msg.payload;
    const fromId = msg.routing.from;
    // React to state changes from observed objects
    if (aspect === 'score') {
      this._lastScore = value;
      await this._draw();
    }
  }

IMPORTANT: Without calling addDependent, you will NOT receive changed events. Every object supports this protocol.

## Runtime Introspection

Every object in the system supports the introspect protocol (abjects:introspect):

  // Ask an object to describe itself (returns manifest + description)
  const info = await this.call(targetId, 'describe', {});

  // Ask an object a targeted question (LLM-powered answer)
  const guide = await this.call(targetId, 'ask',
    { question: 'How do I subscribe to your events?' });

Use this for dynamic composition — objects can learn about each other at runtime.

## Complete Example: Agent Object (autonomous task executor)

An agent registers with AgentAbject, receives tasks via executeTask, and uses the
observe-think-act loop to accomplish work. The LLM chooses actions, and agentAct
executes them by sending messages to other objects.

CRITICAL: intermediateActions MUST only contain 'reply'. ALL domain actions (fetching
data, posting messages, processing, etc.) are executed through agentAct. If you put
domain actions in intermediateActions, they will be SKIPPED entirely.

\`\`\`javascript
({
  _agentAbjectId: null,
  _pendingTickets: null,
  _registered: false,
  _lastResult: null,

  async _registerAgent() {
    if (this._registered) return;
    this._pendingTickets = new Map();
    this._agentAbjectId = await this.dep('AgentAbject');
    await this.call(this._agentAbjectId, 'registerAgent', {
      name: 'WeatherAgent',
      description: 'Fetches weather data and posts reports to chat',
      config: {
        maxSteps: 10,
        timeout: 120000,
        terminalActions: {
          done: { type: 'success', resultFields: ['result'] },
          fail: { type: 'error', resultFields: ['reason'] },
        },
        intermediateActions: ['reply'],  // ONLY 'reply' here. Never add domain actions.
      },
      canExecute: true,
    });
    this._registered = true;
  },

  async startup(msg) {
    await this._registerAgent();
  },

  async executeTask(msg) {
    const { goalId, description, data, approach } = msg.payload;
    const { ticketId } = await this.call(this._agentAbjectId, 'startTask', {
      task: description,
      systemPrompt: \`You are a weather agent. Execute actions to fetch weather and post results.

Available actions (executed via agentAct):
- fetchWeather(location): Fetch current weather for a location
- postToChat(message): Post a formatted message to the chat
- done(result): Task complete, include the final summary
- fail(reason): Task failed

Steps: fetchWeather -> postToChat -> done. Keep it concise.\`,
      goalId,
      initialMessages: approach
        ? [{ role: 'user', content: 'Task: ' + description },
           { role: 'assistant', content: 'I will: ' + approach }]
        : undefined,
      config: { maxSteps: 10, timeout: 120000 },
    });
    const result = await this._waitForTicket(ticketId, 130000);
    return result;
  },

  async agentObserve(msg) {
    // Return current state so the LLM knows what has been done
    return {
      observation: this._lastResult
        ? 'Last action result: ' + JSON.stringify(this._lastResult)
        : 'Ready. Use fetchWeather to get data, then postToChat to deliver it.',
    };
  },

  async agentAct(msg) {
    const { action } = msg.payload;
    // agentAct is where ALL domain work happens.
    // The LLM picks an action, and this handler executes it
    // by sending messages to other objects.
    try {
      if (action.action === 'fetchWeather') {
        const location = action.location || 'Silverdale,WA';
        const resp = await this.call(
          this.dep('HttpClient'), 'get',
          { url: 'https://wttr.in/' + encodeURIComponent(location) + '?format=j1' }
        );
        const data = JSON.parse(resp.body);
        const current = data.current_condition?.[0];
        this._lastResult = {
          tempF: current?.temp_F, condition: current?.weatherDesc?.[0]?.value,
          humidity: current?.humidity, windMph: current?.windspeedMiles,
        };
        return { success: true, data: this._lastResult };
      }

      if (action.action === 'postToChat') {
        const chatId = await this.find('Chat');
        if (chatId) {
          await this.call(chatId, 'addNotification', {
            sender: 'WeatherAgent',
            message: action.message || JSON.stringify(this._lastResult),
          });
        }
        return { success: true, data: { posted: true } };
      }

      if (action.action === 'done') {
        return { success: true, data: action.result };
      }
      if (action.action === 'fail') {
        return { success: false, error: action.reason || 'Task failed' };
      }

      return { success: false, error: 'Unknown action: ' + action.action };
    } catch (err) {
      this._lastResult = { error: String(err) };
      return { success: false, error: String(err) };
    }
  },

  async taskResult(msg) {
    const { ticketId, success, result, error } = msg.payload;
    const pending = this._pendingTickets?.get(ticketId);
    if (pending) {
      this._pendingTickets.delete(ticketId);
      pending.resolve({ success, result, error });
    }
  },

  async agentPhaseChanged(msg) { },
  async agentIntermediateAction(msg) { },
  async agentActionResult(msg) { },

  async _waitForTicket(ticketId, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingTickets?.delete(ticketId);
        reject(new Error('Ticket timeout'));
      }, timeoutMs);
      this._pendingTickets.set(ticketId, {
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
    });
  },

  async getState(msg) {
    return { registered: this._registered };
  },
})
\`\`\`

## Complete Example: Scheduler Object (periodic task creation)

Uses the built-in Scheduler object to register schedules. The Scheduler handles
persistence, enable/disable, and fires jobs via JobManager. On startup, register
the schedule with Scheduler.addSchedule or Scheduler.addScheduleAt.

\`\`\`javascript
({
  _scheduleId: null,

  async startup(msg) {
    if (this._scheduleId) return true;
    // Register a daily schedule at 6:00 AM Pacific Time
    const { scheduleId } = await this.call(
      this.dep('Scheduler'), 'addScheduleAt', {
        description: 'Daily news digest at 6:00 AM PT',
        hour: 6,
        minute: 0,
        timezone: 'America/Los_Angeles',
        // jobCode runs in JobManager sandbox with access to call, dep, find
        jobCode: [
          'const gm = await dep("GoalManager");',
          'const { goalId } = await call(gm, "createGoal", { title: "Daily news digest" });',
          'await call(gm, "addTask", { goalId, description: "Fetch top news headlines and post a summary to chat" });',
          'return { goalId };',
        ].join(' '),
      }
    );
    this._scheduleId = scheduleId;
    return true;
  },

  async getState(msg) {
    return { scheduleId: this._scheduleId };
  },
})
\`\`\`

## Complete Example: Event Watcher Object (event-triggered task creation)

Watches other objects for events and creates goals when events match.
Uses addDependent to subscribe to target objects and receives changed messages.
NOTE: The handler for receiving events from observed objects must be named
'changed' -- this is the standard observer pattern message name.

\`\`\`javascript
({
  _targetId: null,
  _targetName: 'KnowledgeBase',
  _aspectFilter: 'entryAdded',
  _triggerCount: 0,

  async startup(msg) {
    await this._observe();
  },

  async _observe() {
    if (this._targetId) return;
    try {
      const targetId = await this.find(this._targetName);
      if (targetId) {
        await this.call(targetId, 'addDependent', {});
        this._targetId = targetId;
      }
    } catch { /* target may not exist yet */ }
  },

  // Receives events from observed objects (standard observer pattern)
  async changed(msg) {
    const { aspect, value } = msg.payload;
    const senderId = msg.routing.from;
    if (senderId !== this._targetId) return;
    if (this._aspectFilter && this._aspectFilter !== aspect) return;

    // Create a goal with a task for agents to handle
    const gm = this.dep('GoalManager');
    const { goalId } = await this.call(gm, 'createGoal', {
      title: 'Respond to ' + this._targetName + ' ' + aspect,
    });
    await this.call(gm, 'addTask', {
      goalId,
      description: 'Process ' + aspect + ' event from ' + this._targetName,
      data: { triggeredBy: 'event', aspect, value, source: this._targetName },
    });
    this._triggerCount++;
  },

  async getState(msg) {
    return { targetName: this._targetName, observing: !!this._targetId, triggerCount: this._triggerCount };
  },
})
\`\`\`

## Visual Inspection

After your object is spawned or modified, a screenshot of its window will be captured and
evaluated. Your UI must render correctly on the very first frame. Ensure:
- show() draws the complete initial UI before returning
- Text is readable with proper contrast against the background
- Layout elements are properly sized and positioned
- No blank or empty windows -- always draw meaningful content in show()`;
  }

  /**
   * Phase 3 system prompt: verify and fix manifest/code consistency.
   */
  private getPhase3SystemPrompt(): string {
    return `You are an Abjects consistency checker. You verify that a manifest and handler code match exactly.

Rules:
- Every method declared in the manifest MUST have a corresponding handler in the code, EXCEPT these framework-provided methods which are auto-registered and should NOT be in the handler map: ${[...FRAMEWORK_PROVIDED_METHODS].join(', ')}.
- Every public handler (not prefixed with _) in the code MUST be declared in the manifest.
- The handler map MUST be a FLAT parenthesized object: ({ method(msg) { ... } })
- Handlers must NOT be nested under interface keys like { "my:interface": { method() {} } }
- Each handler takes a single msg argument, NOT individual parameters.
- If there are STRUCTURAL ERRORS (nested objects), you MUST flatten the structure.
- If there are mismatches, fix them by updating BOTH the manifest and code as needed.

If everything is consistent, respond with just "VERIFIED".
Otherwise, output the corrected manifest in a \`\`\`json block and the corrected handler code in a \`\`\`javascript block.`;
  }

  /**
   * Modification manifest prompt: generate only the updated manifest JSON.
   * Instructs the LLM to preserve existing name/IDs and add new methods for new functionality.
   */
  private getModificationManifestPrompt(): string {
    return `You are an Abjects manifest designer. You update manifests for existing ScriptableAbjects in a distributed message-passing system.

You are modifying an EXISTING object. You will receive:
- The current manifest
- The current handler code (if any)
- The modification request

Output ONLY the updated manifest JSON in a \`\`\`json code block, followed by a "Used objects:" line listing which available objects the modified implementation will need.

CRITICAL RULES:
- PRESERVE the existing object name and interface IDs (keep the original identity intact).
- PRESERVE all existing methods unless the modification explicitly removes them.
- ADD new methods for new functionality requested by the modification.
- Update method descriptions if behavior changes.
- Only declare methods that WILL actually be implemented in the handler code.
- Study the dependency descriptions carefully. If a dependency declares events, your object MUST declare handler methods for those events so it can receive them.
- Do NOT declare methods you are unsure about implementing.
- Each method needs: name, description, parameters array, and returns type.
- PRESERVE or UPDATE the use cases at the end of the description. If the modification adds new capabilities, add new use cases. Format: '... Use cases: scenario one, scenario two.'

${this.getPhase1SystemPrompt().split('## Common Patterns')[1] ? '## Common Patterns' + this.getPhase1SystemPrompt().split('## Common Patterns')[1] : ''}`;
  }
}

// Well-known object creator ID
export const OBJECT_CREATOR_ID = 'abjects:object-creator' as AbjectId;
