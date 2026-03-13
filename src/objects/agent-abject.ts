/**
 * AgentAbject — concrete agent runtime service.
 *
 * Agents register with this singleton service, providing their identity and
 * configuration. AgentAbject manages the observe→think→act state machine,
 * LLM conversation management, JSON action parsing, and job orchestration.
 * It calls back registered agents for domain-specific work (agentObserve, agentAct).
 *
 * Users can list all agents and send tasks to any of them.
 * User-created ScriptableAbjects can register as agents too — they just need
 * to implement agentObserve and agentAct message handlers.
 */

import Ajv from 'ajv';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { requireDefined } from '../core/contracts.js';
import type { JobResult } from './job-manager.js';
import type { ContentPart } from '../llm/provider.js';
import { Log } from '../core/timed-log.js';

const log = new Log('AgentAbject');

// ─── Shared types ────────────────────────────────────────────────────

export type AgentPhase = 'idle' | 'observing' | 'thinking' | 'acting' | 'done' | 'error';

export interface AgentAction {
  action: string;
  reasoning?: string;
  [key: string]: unknown;
}

export interface AgentActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export interface AgentTaskState {
  id: string;
  phase: AgentPhase;
  step: number;
  maxSteps: number;
  task: string;
  observation?: string;
  action?: AgentAction;
  lastResult?: AgentActionResult;
  result?: unknown;
  error?: string;
  llmMessages: { role: string; content: string | ContentPart[] }[];
  timeout: number;
}

export interface AgentTaskOptions {
  maxSteps?: number;
  timeout?: number;
}

// ─── Agent Config ────────────────────────────────────────────────────

export interface TerminalActionConfig {
  type: 'success' | 'error';
  resultFields?: string[];
}

export interface AgentConfig {
  maxSteps?: number;
  timeout?: number;
  pinnedMessageCount?: number;
  maxConversationMessages?: number;
  queueName?: string;
  directExecution?: boolean;
  skipFirstObservation?: boolean;
  terminalActions?: Record<string, TerminalActionConfig>;
  intermediateActions?: string[];
  fallbackActionName?: string;
}

/** Resolved config with all defaults filled in. */
interface ResolvedAgentConfig {
  maxSteps: number;
  timeout: number;
  pinnedMessageCount: number;
  maxConversationMessages: number;
  queueName?: string;
  directExecution: boolean;
  skipFirstObservation: boolean;
  terminalActions: Record<string, TerminalActionConfig>;
  intermediateActions: string[];
  fallbackActionName: string;
}

// ─── Registration State ──────────────────────────────────────────────

interface RegisteredAgent {
  agentId: AbjectId;
  name: string;
  description: string;
  systemPrompt?: string;
  config: ResolvedAgentConfig;
  registeredAt: number;
}

interface TaskEntry {
  state: AgentTaskState;
  agentId: AbjectId;
  callerId: AbjectId;
  config: ResolvedAgentConfig;
  systemPrompt: string;
  initialMessages?: { role: string; content: string | ContentPart[] }[];
  lastObservationLlmContent?: ContentPart[];
  /** JSON Schema for structured result validation. */
  responseSchema?: Record<string, unknown>;
  /** Original message from startTask caller, for deferred reply. */
  originalMsg: AbjectMessage;
}

// ─── AgentAbject ─────────────────────────────────────────────────────

export const AGENT_ABJECT_ID = 'abjects:agent-abject' as AbjectId;
const AGENT_INTERFACE: InterfaceId = 'abjects:agent-abject';

const DEFAULT_CONFIG: ResolvedAgentConfig = {
  maxSteps: 25,
  timeout: 300000,
  pinnedMessageCount: 2,
  maxConversationMessages: 32,
  queueName: undefined,
  directExecution: false,
  skipFirstObservation: false,
  terminalActions: {
    done: { type: 'success', resultFields: ['result', 'text', 'reasoning'] },
    fail: { type: 'error', resultFields: ['reason', 'error'] },
  },
  intermediateActions: [],
  fallbackActionName: 'done',
};

function resolveConfig(partial?: AgentConfig): ResolvedAgentConfig {
  if (!partial) return { ...DEFAULT_CONFIG, terminalActions: { ...DEFAULT_CONFIG.terminalActions } };
  return {
    maxSteps: partial.maxSteps ?? DEFAULT_CONFIG.maxSteps,
    timeout: partial.timeout ?? DEFAULT_CONFIG.timeout,
    pinnedMessageCount: partial.pinnedMessageCount ?? DEFAULT_CONFIG.pinnedMessageCount,
    maxConversationMessages: partial.maxConversationMessages ?? DEFAULT_CONFIG.maxConversationMessages,
    queueName: partial.queueName ?? DEFAULT_CONFIG.queueName,
    directExecution: partial.directExecution ?? DEFAULT_CONFIG.directExecution,
    skipFirstObservation: partial.skipFirstObservation ?? DEFAULT_CONFIG.skipFirstObservation,
    terminalActions: partial.terminalActions ?? { ...DEFAULT_CONFIG.terminalActions },
    intermediateActions: partial.intermediateActions ?? [...DEFAULT_CONFIG.intermediateActions],
    fallbackActionName: partial.fallbackActionName ?? DEFAULT_CONFIG.fallbackActionName,
  };
}

/** Merge per-task overrides into resolved registration config. */
function mergeConfig(base: ResolvedAgentConfig, override?: Partial<AgentConfig>): ResolvedAgentConfig {
  if (!override) return base;
  return {
    maxSteps: override.maxSteps ?? base.maxSteps,
    timeout: override.timeout ?? base.timeout,
    pinnedMessageCount: override.pinnedMessageCount ?? base.pinnedMessageCount,
    maxConversationMessages: override.maxConversationMessages ?? base.maxConversationMessages,
    queueName: override.queueName ?? base.queueName,
    directExecution: override.directExecution ?? base.directExecution,
    skipFirstObservation: override.skipFirstObservation ?? base.skipFirstObservation,
    terminalActions: override.terminalActions ?? base.terminalActions,
    intermediateActions: override.intermediateActions ?? base.intermediateActions,
    fallbackActionName: override.fallbackActionName ?? base.fallbackActionName,
  };
}

export class AgentAbject extends Abject {
  private llmId?: AbjectId;
  private jobManagerId?: AbjectId;

  private registeredAgents = new Map<AbjectId, RegisteredAgent>();
  private taskEntries = new Map<string, TaskEntry>();
  private taskOrder: string[] = [];

  /** Job submission heartbeat message ID for resetting request timeouts. */
  private _currentJobMsgId?: string;

  /** Lazy Ajv instance for response schema validation. */
  private _ajv?: Ajv;
  private get ajv(): Ajv {
    if (!this._ajv) this._ajv = new Ajv({ allErrors: true });
    return this._ajv;
  }

  constructor() {
    super({
      manifest: {
        name: 'AgentAbject',
        description:
          'Agent runtime service. Agents register with this singleton to get a unified observe→think→act state machine, LLM conversation management, and job orchestration. Users can list agents and send tasks to any of them.',
        version: '1.0.0',
        interface: {
          id: AGENT_INTERFACE,
          name: 'AgentAbject',
          description: 'Agent runtime service for registered agents',
          methods: [
            {
              name: 'registerAgent',
              description: 'Register an agent with the runtime service',
              parameters: [
                { name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Display name' },
                { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'What this agent does' },
                { name: 'systemPrompt', type: { kind: 'primitive', primitive: 'string' }, description: 'Default system prompt', optional: true },
                { name: 'config', type: { kind: 'object', properties: {} }, description: 'Default agent config', optional: true },
              ],
              returns: { kind: 'object', properties: { agentId: { kind: 'primitive', primitive: 'string' } } },
            },
            {
              name: 'unregisterAgent',
              description: 'Unregister the calling agent',
              parameters: [],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
            {
              name: 'listAgents',
              description: 'List all registered agents',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'object', properties: {
                agentId: { kind: 'primitive', primitive: 'string' },
                name: { kind: 'primitive', primitive: 'string' },
                description: { kind: 'primitive', primitive: 'string' },
                status: { kind: 'primitive', primitive: 'string' },
                activeTasks: { kind: 'primitive', primitive: 'number' },
              } } },
            },
            {
              name: 'startTask',
              description: 'Start a task on a registered agent. Returns when the task completes.',
              parameters: [
                { name: 'agentId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target agent (defaults to caller if registered)', optional: true },
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'Caller-provided task ID', optional: true },
                { name: 'task', type: { kind: 'primitive', primitive: 'string' }, description: 'Task description' },
                { name: 'systemPrompt', type: { kind: 'primitive', primitive: 'string' }, description: 'Override system prompt', optional: true },
                { name: 'initialMessages', type: { kind: 'array', elementType: { kind: 'object', properties: {} } }, description: 'Initial conversation messages', optional: true },
                { name: 'config', type: { kind: 'object', properties: {} }, description: 'Per-task config overrides', optional: true },
                { name: 'responseSchema', type: { kind: 'object', properties: {} }, description: 'JSON Schema for structured result', optional: true },
              ],
              returns: { kind: 'object', properties: {
                taskId: { kind: 'primitive', primitive: 'string' },
                success: { kind: 'primitive', primitive: 'boolean' },
                result: { kind: 'primitive', primitive: 'string' },
                error: { kind: 'primitive', primitive: 'string' },
                steps: { kind: 'primitive', primitive: 'number' },
                validationErrors: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              } },
            },
            {
              name: 'getTaskStatus',
              description: 'Get status of a task',
              parameters: [
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'Task ID' },
              ],
              returns: { kind: 'object', properties: {
                phase: { kind: 'primitive', primitive: 'string' },
                step: { kind: 'primitive', primitive: 'number' },
                error: { kind: 'primitive', primitive: 'string' },
                agentId: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'listTasks',
              description: 'List tasks, optionally filtered by agent',
              parameters: [
                { name: 'agentId', type: { kind: 'primitive', primitive: 'string' }, description: 'Filter by agent', optional: true },
              ],
              returns: { kind: 'array', elementType: { kind: 'object', properties: {
                id: { kind: 'primitive', primitive: 'string' },
                agentId: { kind: 'primitive', primitive: 'string' },
                agentName: { kind: 'primitive', primitive: 'string' },
                phase: { kind: 'primitive', primitive: 'string' },
                task: { kind: 'primitive', primitive: 'string' },
                step: { kind: 'primitive', primitive: 'number' },
              } } },
            },
            {
              name: 'cancelTask',
              description: 'Cancel a running task',
              parameters: [
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'Task ID' },
              ],
              returns: { kind: 'object', properties: { success: { kind: 'primitive', primitive: 'boolean' } } },
            },
          ],
          events: [
            {
              name: 'agentRegistered',
              description: 'A new agent registered',
              payload: { kind: 'object', properties: {
                agentId: { kind: 'primitive', primitive: 'string' },
                name: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'taskCompleted',
              description: 'A task completed',
              payload: { kind: 'object', properties: {
                taskId: { kind: 'primitive', primitive: 'string' },
                agentId: { kind: 'primitive', primitive: 'string' },
                success: { kind: 'primitive', primitive: 'boolean' },
              } },
            },
          ],
        },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'agent', 'core'],
      },
    });

    this.setupHandlers();
  }

  protected override getSourceForAsk(): string | undefined {
    return `## AgentAbject Usage Guide

### Register an Agent

  await call(await dep('AgentAbject'), 'registerAgent', {
    name: 'MyAgent',
    description: 'What this agent does',
    config: {
      terminalActions: {
        done: { type: 'success', resultFields: ['result'] },
        fail: { type: 'error', resultFields: ['reason'] },
      },
    },
  });

Your object must implement these callback handlers:
- agentObserve(msg) — return { observation: string, llmContent?: ContentPart[] }
- agentAct(msg) — return { success: boolean, data?: unknown, error?: string }

### Start a Task (free-text result)

  const result = await call(await dep('AgentAbject'), 'startTask', {
    agentId: 'target-agent-id',  // optional if caller is a registered agent
    task: 'Describe the task in natural language',
    config: { maxSteps: 10, timeout: 60000 },
  });
  // result: { taskId, success, result, error, steps }

### Start a Task (structured result with responseSchema)

  const result = await call(await dep('AgentAbject'), 'startTask', {
    agentId: 'target-agent-id',
    task: 'Extract product info from the page',
    responseSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        price: { type: 'number' },
        inStock: { type: 'boolean' },
      },
      required: ['name', 'price'],
    },
  });
  // result: { taskId, success, result: { name, price, inStock }, steps, validationErrors? }
  // validationErrors is undefined when validation passes, or string[] on mismatch

responseSchema is a JSON Schema object. When provided:
- The agent's LLM is instructed to return structured JSON matching the schema
- The result is validated with ajv after completion (soft validation — warns but doesn't reject)
- The result field contains the parsed JSON object instead of a plain string

### List Registered Agents

  const agents = await call(await dep('AgentAbject'), 'listAgents', {});
  // agents: [{ agentId, name, description, status, activeTasks }]

### Cancel a Task

  await call(await dep('AgentAbject'), 'cancelTask', { taskId: 'task-id' });

### IMPORTANT
- startTask is a long-running operation — it drives an observe→think→act loop until done/fail.
- Agents must be registered before tasks can be sent to them.
- The caller receives a deferred reply when the task completes.`;
  }

  protected override async onInit(): Promise<void> {
    this.llmId = await this.discoverDep('LLM') ?? undefined;
    this.jobManagerId = await this.discoverDep('JobManager') ?? undefined;
  }

  /** Resolve a required dependency lazily. */
  private async resolveDep(name: string, cached: AbjectId | undefined): Promise<AbjectId> {
    if (cached) return cached;
    const id = await this.discoverDep(name);
    if (!id) throw new Error(`Required dependency '${name}' not found in Registry`);
    return id;
  }

  private setupHandlers(): void {
    // ── Registration ──
    this.on('registerAgent', async (msg: AbjectMessage) => {
      const { name, description, systemPrompt, config } =
        msg.payload as { name: string; description: string; systemPrompt?: string; config?: AgentConfig };
      const agentId = msg.routing.from;
      const resolved = resolveConfig(config);

      this.registeredAgents.set(agentId, {
        agentId,
        name,
        description,
        systemPrompt,
        config: resolved,
        registeredAt: Date.now(),
      });

      log.info(`Agent registered: "${name}" (${agentId})`);
      this.changed('agentRegistered', { agentId, name }).catch(() => {});
      return { agentId };
    });

    this.on('unregisterAgent', async (msg: AbjectMessage) => {
      const agentId = msg.routing.from;
      const deleted = this.registeredAgents.delete(agentId);
      if (deleted) log.info(`Agent unregistered: ${agentId}`);
      return { success: deleted };
    });

    this.on('listAgents', async () => {
      return [...this.registeredAgents.values()].map(agent => {
        const activeTasks = this.countActiveTasks(agent.agentId);
        return {
          agentId: agent.agentId,
          name: agent.name,
          description: agent.description,
          status: activeTasks > 0 ? 'busy' : 'idle',
          activeTasks,
        };
      });
    });

    // ── Task Management ──
    this.on('startTask', async (msg: AbjectMessage) => {
      const {
        agentId: targetAgentId,
        taskId: callerTaskId,
        task,
        systemPrompt,
        initialMessages,
        config: taskConfig,
        responseSchema,
      } = msg.payload as {
        agentId?: AbjectId;
        taskId?: string;
        task: string;
        systemPrompt?: string;
        initialMessages?: { role: string; content: string | ContentPart[] }[];
        config?: Partial<AgentConfig>;
        responseSchema?: Record<string, unknown>;
      };

      const callerId = msg.routing.from;

      // Determine agent: explicit agentId, or caller if registered
      const agentId = targetAgentId ?? (this.registeredAgents.has(callerId) ? callerId : undefined);
      if (!agentId) throw new Error('No agentId specified and caller is not a registered agent');

      const agent = this.registeredAgents.get(agentId);
      if (!agent) throw new Error(`Agent "${agentId}" is not registered`);

      const taskId = callerTaskId ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const config = mergeConfig(agent.config, taskConfig);
      const prompt = systemPrompt ?? agent.systemPrompt ?? '';

      const taskState = this.createTask(taskId, task, { maxSteps: config.maxSteps, timeout: config.timeout });

      const entry: TaskEntry = {
        state: taskState,
        agentId,
        callerId,
        config,
        systemPrompt: prompt,
        initialMessages,
        responseSchema,
        originalMsg: msg,
      };
      this.taskEntries.set(taskId, entry);

      // Fire-and-forget: run the state machine asynchronously
      this.runTaskAsync(entry);
      return DEFERRED_REPLY;
    });

    this.on('getTaskStatus', async (msg: AbjectMessage) => {
      const { taskId } = msg.payload as { taskId: string };
      const entry = this.taskEntries.get(taskId);
      if (!entry) return { phase: 'unknown', step: 0, error: 'Task not found' };
      return {
        phase: entry.state.phase,
        step: entry.state.step,
        error: entry.state.error,
        agentId: entry.agentId,
      };
    });

    this.on('listTasks', async (msg: AbjectMessage) => {
      const { agentId } = (msg.payload ?? {}) as { agentId?: AbjectId };
      return this.taskOrder
        .map(id => this.taskEntries.get(id))
        .filter((e): e is TaskEntry => !!e && (!agentId || e.agentId === agentId))
        .map(e => ({
          id: e.state.id,
          agentId: e.agentId,
          agentName: this.registeredAgents.get(e.agentId)?.name ?? 'unknown',
          phase: e.state.phase,
          task: e.state.task.slice(0, 100),
          step: e.state.step,
        }));
    });

    this.on('cancelTask', async (msg: AbjectMessage) => {
      const { taskId } = msg.payload as { taskId: string };
      const entry = this.taskEntries.get(taskId);
      if (!entry) return { success: false };
      if (entry.state.phase === 'done' || entry.state.phase === 'error') return { success: false };
      entry.state.phase = 'error';
      entry.state.error = 'Cancelled';
      return { success: true };
    });

    // ── Internal step handler (called by job code) ──
    // Only _think needs to go through AgentAbject (it accesses conversation
    // state + LLM).  Observe and act job code call agents directly to avoid
    // deadlocks — Abject handlers are serialized, so nested callbacks through
    // this object would block the message processing loop.
    this.on('_think', async (msg: AbjectMessage) => {
      const { taskId } = msg.payload as { taskId: string };
      const entry = requireDefined(this.taskEntries.get(taskId), `Task ${taskId} not found`);
      return this.think(entry);
    });

    this.on('progress', () => {
      if (this._currentJobMsgId) {
        this.resetRequestTimeout(this._currentJobMsgId);
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Helpers
  // ═══════════════════════════════════════════════════════════════════

  private countActiveTasks(agentId: AbjectId): number {
    let count = 0;
    for (const entry of this.taskEntries.values()) {
      if (entry.agentId === agentId && entry.state.phase !== 'done' && entry.state.phase !== 'error') {
        count++;
      }
    }
    return count;
  }

  private createTask(id: string, taskText: string, options?: AgentTaskOptions): AgentTaskState {
    const task: AgentTaskState = {
      id,
      phase: 'idle',
      step: 0,
      maxSteps: options?.maxSteps ?? 25,
      task: taskText,
      timeout: options?.timeout ?? 300000,
      llmMessages: [],
    };
    this.taskOrder.unshift(id);
    return task;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Observe / Act via callbacks to registered agent
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Send agentObserve request to the registered agent.
   * Returns the full result (observation + optional llmContent).
   * Used by directExecution mode; job mode calls the agent directly.
   */
  private async observeStep(entry: TaskEntry): Promise<{ observation: string; llmContent?: ContentPart[] }> {
    return this.request<{ observation: string; llmContent?: ContentPart[] }>(
      request(this.id, entry.agentId, 'agentObserve', {
        taskId: entry.state.id,
        step: entry.state.step,
      }),
      60000,
    );
  }

  /**
   * Send agentAct request to the registered agent.
   * Used by directExecution mode; job mode calls the agent directly.
   */
  private async actStep(entry: TaskEntry): Promise<AgentActionResult> {
    return this.request<AgentActionResult>(
      request(this.id, entry.agentId, 'agentAct', {
        taskId: entry.state.id,
        step: entry.state.step,
        action: entry.state.action,
      }),
      entry.config.timeout,
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Event notifications to registered agent
  // ═══════════════════════════════════════════════════════════════════

  private emitPhaseChanged(entry: TaskEntry, oldPhase: AgentPhase, newPhase: AgentPhase): void {
    this.send(event(this.id, entry.agentId, 'agentPhaseChanged', {
      taskId: entry.state.id,
      step: entry.state.step,
      oldPhase,
      newPhase,
      action: entry.state.action?.action,
    })).catch(() => {});
  }

  private emitIntermediateAction(entry: TaskEntry): void {
    this.send(event(this.id, entry.agentId, 'agentIntermediateAction', {
      taskId: entry.state.id,
      action: entry.state.action,
    })).catch(() => {});
  }

  private emitActionResult(entry: TaskEntry): void {
    this.send(event(this.id, entry.agentId, 'agentActionResult', {
      taskId: entry.state.id,
      action: entry.state.action,
      result: entry.state.lastResult,
    })).catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════════════
  // Config-driven terminal/intermediate action checking
  // ═══════════════════════════════════════════════════════════════════

  private isTerminalAction(entry: TaskEntry, action: AgentAction): 'success' | 'error' | null {
    const config = entry.config;
    const terminal = config.terminalActions[action.action];
    if (!terminal) return null;

    if (terminal.type === 'success') {
      // Try each result field in order
      for (const field of (terminal.resultFields ?? [])) {
        if (action[field] !== undefined) {
          entry.state.result = action[field];
          break;
        }
      }
      if (entry.state.result === undefined) {
        entry.state.result = action.reasoning;
      }
      return 'success';
    }

    if (terminal.type === 'error') {
      for (const field of (terminal.resultFields ?? [])) {
        if (action[field] !== undefined) {
          entry.state.error = String(action[field]);
          break;
        }
      }
      if (!entry.state.error) {
        entry.state.error = 'Agent decided to fail';
      }
      return 'error';
    }

    return null;
  }

  private isIntermediateAction(entry: TaskEntry, action: AgentAction): boolean {
    return entry.config.intermediateActions.includes(action.action);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Async Task Runner
  // ═══════════════════════════════════════════════════════════════════

  private async runTaskAsync(entry: TaskEntry): Promise<void> {
    try {
      await this.runStateMachine(entry);
    } catch (err) {
      entry.state.phase = 'error';
      entry.state.error = err instanceof Error ? err.message : String(err);
    }

    // Send deferred reply to startTask caller
    const success = entry.state.phase === 'done';

    // Validate result against responseSchema if present (soft validation — warn only)
    let validationErrors: string[] | undefined;
    if (success && entry.responseSchema && entry.state.result !== undefined) {
      // Parse result if it's a string (LLM may return JSON as string)
      if (typeof entry.state.result === 'string') {
        try { entry.state.result = JSON.parse(entry.state.result); } catch { /* keep as string */ }
      }
      const validate = this.ajv.compile(entry.responseSchema);
      if (!validate(entry.state.result)) {
        validationErrors = validate.errors?.map(e => `${e.instancePath} ${e.message}`) ?? [];
        log.warn(`Schema validation failed for task ${entry.state.id}:`, validationErrors);
      }
    }

    try {
      await this.sendDeferredReply(entry.originalMsg, {
        taskId: entry.state.id,
        success,
        result: entry.state.result,
        error: entry.state.error,
        steps: entry.state.step,
        validationErrors,
      });
    } catch { /* caller may be gone */ }

    this.changed('taskCompleted', {
      taskId: entry.state.id,
      agentId: entry.agentId,
      success,
    }).catch(() => {});
  }

  // ═══════════════════════════════════════════════════════════════════
  // State Machine
  // ═══════════════════════════════════════════════════════════════════

  private async runStateMachine(entry: TaskEntry): Promise<void> {
    const task = entry.state;
    const agentName = this.registeredAgents.get(entry.agentId)?.name ?? 'Unknown';
    log.info(`[${agentName}] Task started: "${task.task.slice(0, 80)}" (${task.id}, max ${task.maxSteps} steps)`);

    let phase = 'observing' as AgentPhase;
    task.phase = phase;
    this.emitPhaseChanged(entry, 'idle', phase);

    const setPhase = (newPhase: AgentPhase): void => {
      const old = phase;
      phase = newPhase;
      task.phase = newPhase;
      this.emitPhaseChanged(entry, old, newPhase);
    };

    try {
      while (phase !== 'done' && phase !== 'error') {
        switch (phase) {
          case 'observing': {
            // Skip observation on step 0 if configured
            if (task.step === 0 && entry.config.skipFirstObservation) {
              setPhase('thinking');
              break;
            }

            log.info(`[${agentName}] Step ${task.step + 1} — observing`);
            // Job calls agent directly (not through _observe handler) to avoid
            // deadlocks — Abject handlers are serialized, and nested callbacks
            // through this object would block the message processing loop.
            const obsResult = await this.executeStep(
              entry,
              `[${agentName}] Observe (step ${task.step + 1})`,
              `return await call('${entry.agentId}', 'agentObserve', { taskId: '${task.id}', step: ${task.step} })`,
              () => this.observeStep(entry),
            );
            if (!obsResult.success) {
              setPhase('error');
              task.error = obsResult.error;
              break;
            }
            const obsData = obsResult.data as { observation: string; llmContent?: ContentPart[] };
            task.observation = obsData.observation;
            if (obsData.llmContent) entry.lastObservationLlmContent = obsData.llmContent;
            else entry.lastObservationLlmContent = undefined;
            setPhase('thinking');
            break;
          }

          case 'thinking': {
            log.info(`[${agentName}] Step ${task.step + 1} — thinking (awaiting LLM)`);
            const thinkResult = await this.executeStep(
              entry,
              `[${agentName}] Plan next action (step ${task.step + 1})`,
              `return await call('${this.id}', '_think', { taskId: '${task.id}' })`,
              () => this.think(entry),
            );
            if (!thinkResult.success) {
              setPhase('error');
              task.error = thinkResult.error;
              break;
            }
            task.action = thinkResult.data as AgentAction;

            // Check terminal
            const terminal = this.isTerminalAction(entry, task.action);
            if (terminal === 'success') {
              setPhase('done');
              break;
            }
            if (terminal === 'error') {
              setPhase('error');
              break;
            }

            // Check intermediate
            if (this.isIntermediateAction(entry, task.action)) {
              this.emitIntermediateAction(entry);
              task.step++;
              if (task.step >= task.maxSteps) {
                setPhase('error');
                task.error = `Max steps (${task.maxSteps}) reached`;
                break;
              }
              setPhase('observing');
              break;
            }

            setPhase('acting');
            break;
          }

          case 'acting': {
            log.info(`[${agentName}] Step ${task.step + 1} — acting: ${task.action?.action} (${(task.action?.reasoning ?? '').toString().slice(0, 60)})`);
            const desc = (task.action?.reasoning ?? task.action?.action ?? 'act').toString().slice(0, 80);
            // Job calls agent directly (not through _act handler) to avoid
            // deadlocks — the agent's act callback may call other objects that
            // send messages back to AgentAbject (e.g. Chat → WebAgent → startTask).
            const actionJson = JSON.stringify(task.action);
            const actResult = await this.executeStep(
              entry,
              `[${agentName}] ${desc} (step ${task.step + 1})`,
              `return await call('${entry.agentId}', 'agentAct', { taskId: '${task.id}', step: ${task.step}, action: ${actionJson} })`,
              async () => this.actStep(entry),
            );
            task.lastResult = {
              success: actResult.success,
              data: actResult.data,
              error: actResult.error,
            };
            this.emitActionResult(entry);
            log.info(`[${agentName}] Step ${task.step + 1} — action result: ${actResult.success ? 'success' : 'failed: ' + actResult.error}`);
            task.step++;

            if (task.step >= task.maxSteps) {
              setPhase('error');
              task.error = `Max steps (${task.maxSteps}) reached`;
              break;
            }

            setPhase('observing');
            break;
          }
        }
      }
    } finally {
      if (task.phase === 'done') {
        log.info(`[${agentName}] Task done in ${task.step} steps`);
      } else if (task.phase === 'error') {
        log.info(`[${agentName}] Task error at step ${task.step}: ${task.error}`);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Step Execution (direct or via JobManager)
  // ═══════════════════════════════════════════════════════════════════

  private async executeStep(
    entry: TaskEntry,
    description: string,
    jobCode: string,
    directFn: () => Promise<unknown>,
  ): Promise<AgentActionResult> {
    if (entry.config.directExecution) {
      try {
        const data = await directFn();
        return { success: true, data };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    // Recover from error status if a previous handler threw
    if (this._status === 'error') {
      this.recover();
    }

    return this.submitJob(entry, description, jobCode);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Job Submission (with progress heartbeat)
  // ═══════════════════════════════════════════════════════════════════

  private async submitJob(
    entry: TaskEntry,
    description: string,
    code: string,
  ): Promise<AgentActionResult> {
    try {
      const jobMgrId = await this.resolveDep('JobManager', this.jobManagerId);
      const submitMsg = request(this.id, jobMgrId, 'submitJob', {
        description,
        code,
        ...(entry.config.queueName ? { queue: entry.config.queueName } : {}),
      });
      this._currentJobMsgId = submitMsg.header.messageId;
      let jobResult: JobResult;
      try {
        jobResult = await this.request<JobResult>(submitMsg, entry.state.timeout);
      } finally {
        this._currentJobMsgId = undefined;
      }
      if (jobResult.status === 'completed') {
        return { success: true, data: jobResult.result };
      }
      return { success: false, error: jobResult.error ?? 'Job failed' };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Think (LLM conversation management)
  // ═══════════════════════════════════════════════════════════════════

  private async think(entry: TaskEntry): Promise<AgentAction> {
    const task = entry.state;

    // Initialize conversation if empty
    if (task.llmMessages.length === 0) {
      task.llmMessages = this.initializeConversation(entry);
    }

    // Add observation
    this.addObservationToConversation(entry);

    // Add last action result
    this.addActionResultToConversation(entry);

    // Trim conversation
    this.trimConversation(entry);

    this.llmId = await this.resolveDep('LLM', this.llmId);
    const llmResult = await this.request<{ content: string }>(
      request(this.id, this.llmId, 'complete', {
        messages: task.llmMessages,
        options: { tier: 'balanced', maxTokens: 2048 },
      }),
      120000,
    );

    // Add assistant response
    task.llmMessages.push({ role: 'assistant', content: llmResult.content });

    const agentName = this.registeredAgents.get(entry.agentId)?.name ?? 'Unknown';
    const parsed = this.parseAction(entry, llmResult.content);
    log.info(`[${agentName}] Step ${task.step + 1} — LLM action: ${parsed.action}${parsed.reasoning ? ' (' + parsed.reasoning.slice(0, 60) + ')' : ''}`);
    return parsed;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Conversation Management
  // ═══════════════════════════════════════════════════════════════════

  private initializeConversation(entry: TaskEntry): { role: string; content: string | ContentPart[] }[] {
    const messages: { role: string; content: string | ContentPart[] }[] = [];

    let prompt = entry.systemPrompt;
    if (entry.responseSchema) {
      prompt += `\n\n## Response Schema\nWhen you complete the task, the "result" field of your terminal action MUST be a JSON object (not a string) conforming to this schema:\n\`\`\`json\n${JSON.stringify(entry.responseSchema, null, 2)}\n\`\`\`\nIMPORTANT: The "result" value must be a structured JSON object, NOT a string. Include all required fields. Use exact property names from the schema.`;
    }

    if (prompt) {
      messages.push({ role: 'system', content: prompt });
    }

    if (entry.initialMessages && entry.initialMessages.length > 0) {
      messages.push(...entry.initialMessages);
    } else {
      messages.push({ role: 'user', content: `Task: ${entry.state.task}` });
    }

    return messages;
  }

  private addObservationToConversation(entry: TaskEntry): void {
    const task = entry.state;

    // Skip observation on step 0 if configured (context is already in initialMessages)
    if (task.step === 0 && entry.config.skipFirstObservation) return;

    if (!task.observation) return;

    // If agent provided llmContent (e.g. screenshot), use it directly
    if (entry.lastObservationLlmContent) {
      task.llmMessages.push({
        role: 'user',
        content: entry.lastObservationLlmContent,
      });
      entry.lastObservationLlmContent = undefined;
      return;
    }

    task.llmMessages.push({
      role: 'user',
      content: `[Observation - Step ${task.step + 1}]\n${task.observation}`,
    });
  }

  private addActionResultToConversation(entry: TaskEntry): void {
    const task = entry.state;
    if (!task.lastResult) return;

    const action = task.action;
    const resultStr = task.lastResult.success
      ? `Action "${action?.action}" succeeded: ${JSON.stringify(task.lastResult.data)?.slice(0, 500) ?? 'ok'}`
      : `Action "${action?.action}" failed: ${task.lastResult.error}`;
    task.llmMessages.push({ role: 'user', content: `[Action Result]\n${resultStr}` });
  }

  private trimConversation(entry: TaskEntry): void {
    const task = entry.state;
    const max = entry.config.maxConversationMessages;
    if (task.llmMessages.length <= max) return;

    const pinned = task.llmMessages.slice(0, entry.config.pinnedMessageCount);
    const recent = task.llmMessages.slice(-(max - entry.config.pinnedMessageCount));
    task.llmMessages = [...pinned, ...recent];
  }

  // ═══════════════════════════════════════════════════════════════════
  // Action Parsing
  // ═══════════════════════════════════════════════════════════════════

  private parseAction(entry: TaskEntry, content: string): AgentAction {
    // Try ```json block
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      const parsed = this.tryParseActionJson(jsonMatch[1].trim());
      if (parsed) return parsed;
    }

    // Fallback: unclosed ```json block
    const unclosedMatch = content.match(/```json\s*([\s\S]*)/);
    if (unclosedMatch && !jsonMatch) {
      const parsed = this.tryParseActionJson(unclosedMatch[1].trim());
      if (parsed) return parsed;
    }

    // Try whole content as JSON
    const parsed = this.tryParseActionJson(content);
    if (parsed) return parsed;

    // Config-driven fallback
    return { action: entry.config.fallbackActionName, result: content, reasoning: 'Could not parse action, returning raw response' };
  }

  private tryParseActionJson(raw: string): AgentAction | null {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.action === 'string') {
        return parsed as AgentAction;
      }
    } catch {
      // Try repairing truncated JSON
      const suffixes = ['"}', '"}]', '}}', '}'];
      for (const suffix of suffixes) {
        try {
          const repaired = JSON.parse(raw + suffix);
          if (typeof repaired.action === 'string') return repaired as AgentAction;
        } catch { /* try next */ }
      }

      // Last resort: regex-extract action
      const actionMatch = raw.match(/"action"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (actionMatch) {
        const action: AgentAction = { action: actionMatch[1] };
        const textMatch = raw.match(/"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (textMatch) action.text = textMatch[1].replace(/\\"/g, '"');
        const resultMatch = raw.match(/"result"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (resultMatch) action.result = resultMatch[1].replace(/\\"/g, '"');
        return action;
      }
    }
    return null;
  }
}
