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
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { requireDefined } from '../core/contracts.js';
import type { JobResult } from './job-manager.js';
import type { ContentPart } from '../llm/provider.js';
import type { EnabledSkillSummary } from '../core/skill-types.js';
import { Log } from '../core/timed-log.js';

const log = new Log('AgentAbject');

// ─── Shared types ────────────────────────────────────────────────────

export type AgentPhase = 'idle' | 'observing' | 'thinking' | 'acting' | 'done' | 'error';

export interface AgentPlan {
  summary: string;
  steps: AgentPlanStep[];
  revision: number;        // 0 = initial, increments on replan
}

export interface AgentPlanStep {
  id: string;              // "step-1", "step-2", ...
  description: string;
  taskType: string;        // Required — every step becomes a TupleSpace task
  taskId?: string;         // Set after TupleSpace task is created
  data?: unknown;          // Optional task-specific payload
}

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
  plan?: AgentPlan;
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
  taskTypes: string[];
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
  /** Goal ID for cross-agent progress tracking via GoalManager. */
  goalId?: string;
  /** Set when task came from dispatch (the parent goal). */
  incomingGoalId?: string;
  /** Set when planning creates a child goal for a dispatched task. */
  childGoalId?: string;
  /** Active child goal IDs created by decompose. */
  childGoalIds?: string[];
  /** Cached skill instructions appended to system prompt. */
  skillPromptSuffix?: string;
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
  private goalManagerId?: AbjectId;
  private tupleSpaceId?: AbjectId;

  private registeredAgents = new Map<AbjectId, RegisteredAgent>();
  private taskEntries = new Map<string, TaskEntry>();
  private taskOrder: string[] = [];

  /** Guard: tuple IDs currently being dispatched — prevents concurrent dispatch loops. */
  private dispatchingTuples = new Set<string>();

  /** Agents currently executing a dispatched TupleSpace task (one task at a time per agent). */
  private busyAgents = new Set<AbjectId>();

  /** Periodic scan timer for catching missed/pre-existing tasks. */
  private scanTimer?: ReturnType<typeof setInterval>;

  /** Job submission heartbeat message ID for resetting request timeouts. */
  private _currentJobMsgId?: string;

  /** Active executeTask dispatch message ID for resetting request timeouts on progress. */
  private _currentDispatchMsgId?: string;

  /** Active task entry during LLM streaming — links llmChunk events to the right ticket. */
  private activeStreamEntry?: TaskEntry;

  /** Resolvers for event-driven child goal observation. */
  private childGoalEventResolvers = new Map<string, {
    resolve: (evt: { aspect: string; goalId: string; taskId?: string; result?: unknown; error?: string }) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

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
                { name: 'taskTypes', type: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } }, description: 'Task types this agent can handle (e.g. create, modify, browse, research, web)', optional: true },
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
              description: 'Start a task on a registered agent. Returns a ticketId immediately; result arrives via taskResult event. Default maxSteps is 25. When the step limit is reached, the agent makes one final LLM call to return collected data, then salvages the last successful result, or errors. Pass config.maxSteps to override.',
              parameters: [
                { name: 'agentId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target agent (defaults to caller if registered)', optional: true },
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'Caller-provided task ID', optional: true },
                { name: 'task', type: { kind: 'primitive', primitive: 'string' }, description: 'Task description' },
                { name: 'systemPrompt', type: { kind: 'primitive', primitive: 'string' }, description: 'Override system prompt', optional: true },
                { name: 'initialMessages', type: { kind: 'array', elementType: { kind: 'object', properties: {} } }, description: 'Initial conversation messages', optional: true },
                { name: 'config', type: { kind: 'object', properties: {} }, description: 'Per-task config overrides: { maxSteps?: number (default 25), timeout?: number (default 300000ms) }', optional: true },
                { name: 'responseSchema', type: { kind: 'object', properties: {} }, description: 'JSON Schema for structured result', optional: true },
              ],
              returns: { kind: 'object', properties: {
                ticketId: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'getTicket',
              description: 'Poll a ticket for its current status and result',
              parameters: [
                { name: 'ticketId', type: { kind: 'primitive', primitive: 'string' }, description: 'Ticket ID from startTask' },
              ],
              returns: { kind: 'object', properties: {
                ticketId: { kind: 'primitive', primitive: 'string' },
                status: { kind: 'primitive', primitive: 'string' },
                phase: { kind: 'primitive', primitive: 'string' },
                step: { kind: 'primitive', primitive: 'number' },
                maxSteps: { kind: 'primitive', primitive: 'number' },
                result: { kind: 'primitive', primitive: 'string' },
                error: { kind: 'primitive', primitive: 'string' },
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
                goalId: { kind: 'primitive', primitive: 'string' },
              } } },
            },
            {
              name: 'getAgentState',
              description: 'Get detailed state for a registered agent including its current tasks and goals',
              parameters: [
                { name: 'agentId', type: { kind: 'primitive', primitive: 'string' }, description: 'Agent ID' },
              ],
              returns: { kind: 'object', properties: {
                agentId: { kind: 'primitive', primitive: 'string' },
                name: { kind: 'primitive', primitive: 'string' },
                description: { kind: 'primitive', primitive: 'string' },
                status: { kind: 'primitive', primitive: 'string' },
                tasks: { kind: 'array', elementType: { kind: 'object', properties: {
                  id: { kind: 'primitive', primitive: 'string' },
                  phase: { kind: 'primitive', primitive: 'string' },
                  task: { kind: 'primitive', primitive: 'string' },
                  step: { kind: 'primitive', primitive: 'number' },
                  goalId: { kind: 'primitive', primitive: 'string' },
                } } },
              } },
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
              description: 'A task completed (broadcast)',
              payload: { kind: 'object', properties: {
                taskId: { kind: 'primitive', primitive: 'string' },
                agentId: { kind: 'primitive', primitive: 'string' },
                success: { kind: 'primitive', primitive: 'boolean' },
                result: { kind: 'primitive', primitive: 'string' },
                error: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'taskResult',
              description: 'Sent to the ticket holder when a task completes',
              payload: { kind: 'object', properties: {
                ticketId: { kind: 'primitive', primitive: 'string' },
                success: { kind: 'primitive', primitive: 'boolean' },
                result: { kind: 'primitive', primitive: 'string' },
                error: { kind: 'primitive', primitive: 'string' },
                steps: { kind: 'primitive', primitive: 'number' },
                maxStepsReached: { kind: 'primitive', primitive: 'boolean' },
                validationErrors: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
              } },
            },
            {
              name: 'taskProgress',
              description: 'Sent to the ticket holder on each phase transition',
              payload: { kind: 'object', properties: {
                ticketId: { kind: 'primitive', primitive: 'string' },
                step: { kind: 'primitive', primitive: 'number' },
                maxSteps: { kind: 'primitive', primitive: 'number' },
                phase: { kind: 'primitive', primitive: 'string' },
                action: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'taskStream',
              description: 'Sent to the ticket holder with streaming LLM tokens',
              payload: { kind: 'object', properties: {
                ticketId: { kind: 'primitive', primitive: 'string' },
                content: { kind: 'primitive', primitive: 'string' },
                done: { kind: 'primitive', primitive: 'boolean' },
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

### Start a Task (ticket pattern)

startTask returns a ticketId immediately. The result arrives as a taskResult event.

  // 1. Register a taskResult handler to receive results
  this.on('taskResult', (msg) => {
    const { ticketId, success, result, error, steps, maxStepsReached } = msg.payload;
    // Handle the result...
  });

  // 2. Submit the task — returns immediately with { ticketId }
  const { ticketId } = await call(await dep('AgentAbject'), 'startTask', {
    agentId: 'target-agent-id',  // optional if caller is a registered agent
    task: 'Describe the task in natural language',
    config: { maxSteps: 10, timeout: 60000 },
  });

### Step Limits
- **maxSteps defaults to 25.** Each observe-think-act cycle counts as one step.
- When the limit is reached, the agent makes one final LLM call asking for a done/fail response.
- If that fails, it salvages the last successful action result.
- If nothing was collected, the task errors with "Max steps reached".
- The taskResult event includes \`maxStepsReached: true\` when the limit was hit.
- For complex tasks (pagination, multi-step workflows), pass a higher maxSteps (e.g. 30-50).

  // 3. Optionally handle taskProgress events for live updates
  this.on('taskProgress', (msg) => {
    const { ticketId, step, maxSteps, phase, action } = msg.payload;
  });

  // 4. Optionally handle taskStream events for streaming LLM tokens
  this.on('taskStream', (msg) => {
    const { ticketId, content, done } = msg.payload;
  });

### Structured Result with responseSchema

  const { ticketId } = await call(await dep('AgentAbject'), 'startTask', {
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
  // taskResult event: { ticketId, success, result: { name, price, inStock }, steps, validationErrors? }

### Poll a Ticket

  const status = await call(await dep('AgentAbject'), 'getTicket', { ticketId });
  // status: { ticketId, status: 'pending'|'running'|'completed'|'failed', phase, step, maxSteps, result?, error? }

### List Registered Agents

  const agents = await call(await dep('AgentAbject'), 'listAgents', {});
  // agents: [{ agentId, name, description, status, activeTasks }]

### Get Agent State (with current tasks and goals)

  const state = await call(await dep('AgentAbject'), 'getAgentState', { agentId: 'some-agent-id' });
  // state: { agentId, name, description, status, tasks: [{ id, phase, task, step, goalId }] }
  // Each active task includes its goalId for cross-referencing with GoalManager

### Cancel a Task

  await call(await dep('AgentAbject'), 'cancelTask', { taskId: 'ticket-id' });

### Goal Tracking

Every task automatically gets a Goal (via GoalManager) for cross-agent progress tracking.
Pass an existing goalId to link a task to a parent goal:

  const { ticketId } = await call(await dep('AgentAbject'), 'startTask', {
    task: 'Do something',
    goalId: 'existing-goal-id',  // optional — auto-created if omitted
  });

Inside job code, goal helpers are available automatically:
- await updateGoal('Building UI...', 'phase-name')
- await getGoal()  // returns current Goal object
- await completeGoal(result)
- await failGoal('reason')

### Task Dispatch & Semantic Matching

Tasks are dispatched to agents via TupleSpace. Dispatch uses two strategies:

1. **Exact type match** — agents whose taskTypes include the task's type are preferred.
2. **LLM semantic fallback** — if no agent declares the type, a fast LLM call picks
   the best agent based on its name and description.

This means agents can receive tasks outside their declared taskTypes if the LLM
determines they are a good fit. Write clear, descriptive agent descriptions to
improve semantic matching accuracy.

### IMPORTANT
- startTask returns { ticketId } immediately — it does NOT block until completion.
- Results arrive asynchronously via a taskResult event sent to the caller.
- taskProgress events provide live step/phase updates during execution.
- taskStream events provide streaming LLM tokens during the think phase.
- Agents must be registered before tasks can be sent to them.
- listTasks includes goalId on each task entry for cross-referencing with GoalManager.
- getAgentState returns an agent's active tasks with their goalIds — use it to see what an agent is working on.
- Tasks are never silently dropped — if no exact type match exists, LLM semantic fallback finds the best agent by description.`;
  }

  protected override async onInit(): Promise<void> {
    this.llmId = await this.discoverDep('LLM') ?? undefined;
    this.jobManagerId = await this.discoverDep('JobManager') ?? undefined;
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;
    this.tupleSpaceId = await this.discoverDep('TupleSpace') ?? undefined;

    // Subscribe to TupleSpace for centralized task dispatch
    if (this.tupleSpaceId) {
      this.send(request(this.id, this.tupleSpaceId, 'addDependent', {}));
    }

    // Subscribe to GoalManager for child goal completion events
    if (this.goalManagerId) {
      this.send(request(this.id, this.goalManagerId, 'addDependent', {}));
    }

    // Periodic scan for missed/pre-existing tasks (every 30s)
    this.scanTimer = setInterval(() => {
      this.periodicScan().catch(err => {
        log.warn('Periodic scan failed:', err instanceof Error ? err.message : String(err));
      });
    }, 30_000);

    // Initial scan after 5s delay (give agents time to register)
    setTimeout(() => {
      this.periodicScan().catch(err => {
        log.warn('Initial scan failed:', err instanceof Error ? err.message : String(err));
      });
    }, 5000);
  }

  protected override async onStop(): Promise<void> {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = undefined;
    }
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
      const { name, description, systemPrompt, config, taskTypes } =
        msg.payload as { name: string; description: string; systemPrompt?: string; config?: AgentConfig; taskTypes?: string[] };
      const agentId = msg.routing.from;
      const resolved = resolveConfig(config);

      this.registeredAgents.set(agentId, {
        agentId,
        name,
        description,
        systemPrompt,
        config: resolved,
        taskTypes: taskTypes ?? [],
        registeredAt: Date.now(),
      });

      log.info(`Agent registered: "${name}" (${agentId})`);
      this.changed('agentRegistered', { agentId, name });
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
        goalId: incomingGoalId,
      } = msg.payload as {
        agentId?: AbjectId;
        taskId?: string;
        task: string;
        systemPrompt?: string;
        initialMessages?: { role: string; content: string | ContentPart[] }[];
        config?: Partial<AgentConfig>;
        responseSchema?: Record<string, unknown>;
        goalId?: string;
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

      // Every task has a goal — use provided one or auto-create
      let goalId = incomingGoalId;
      if (!goalId && this.goalManagerId) {
        try {
          const goalResult = await this.request<{ goalId: string }>(
            request(this.id, this.goalManagerId, 'createGoal', {
              title: task.slice(0, 100),
            })
          );
          goalId = goalResult.goalId;
        } catch { /* GoalManager may not be ready */ }
      }

      const entry: TaskEntry = {
        state: taskState,
        agentId,
        callerId,
        config,
        systemPrompt: prompt,
        initialMessages,
        responseSchema,
        goalId,
      };

      // Pre-fetch enabled skill instructions for prompt injection
      try {
        const skillRegistryId = await this.discoverDep('SkillRegistry');
        if (skillRegistryId) {
          const skills = await this.request<EnabledSkillSummary[]>(
            request(this.id, skillRegistryId, 'getEnabledSkills', {}),
          );
          if (skills.length > 0) {
            let suffix = '\n\n## Available Skills\n';
            for (const skill of skills) {
              suffix += `### ${skill.name}\n${skill.description}\n`;
              suffix += skill.instructions + '\n\n';
            }
            entry.skillPromptSuffix = suffix;
          }
        }
      } catch { /* SkillRegistry not available, continue without skills */ }

      this.taskEntries.set(taskId, entry);

      // Fire-and-forget: run the state machine asynchronously
      this.runTaskAsync(entry);
      return { ticketId: taskId };
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
          goalId: e.goalId ?? null,
        }));
    });

    this.on('getAgentState', async (msg: AbjectMessage) => {
      const { agentId } = msg.payload as { agentId: AbjectId };
      const agent = this.registeredAgents.get(agentId);
      if (!agent) return { error: 'Agent not found' };
      const tasks: { id: string; phase: string; task: string; step: number; goalId: string | null }[] = [];
      for (const entry of this.taskEntries.values()) {
        if (entry.agentId === agentId && entry.state.phase !== 'done' && entry.state.phase !== 'error') {
          tasks.push({
            id: entry.state.id,
            phase: entry.state.phase,
            task: entry.state.task.slice(0, 100),
            step: entry.state.step,
            goalId: entry.goalId ?? null,
          });
        }
      }
      return {
        agentId: agent.agentId,
        name: agent.name,
        description: agent.description,
        status: tasks.length > 0 ? 'busy' : 'idle',
        tasks,
      };
    });

    this.on('getTicket', async (msg: AbjectMessage) => {
      const { ticketId } = msg.payload as { ticketId: string };
      const entry = this.taskEntries.get(ticketId);
      if (!entry) return { ticketId, status: 'unknown' };
      const phase = entry.state.phase;
      const status = phase === 'done' ? 'completed'
        : phase === 'error' ? 'failed'
        : phase === 'idle' ? 'pending' : 'running';
      return {
        ticketId,
        status,
        phase,
        step: entry.state.step,
        maxSteps: entry.state.maxSteps,
        result: phase === 'done' ? entry.state.result : undefined,
        error: phase === 'error' ? entry.state.error : undefined,
      };
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

    // ── LLM streaming chunk forwarding ──
    this.on('llmChunk', async (msg: AbjectMessage) => {
      const { correlationId, content, done } = msg.payload as {
        correlationId: string; content: string; done: boolean;
      };
      const entry = this.activeStreamEntry;
      if (!entry) return;
      // Forward to ticket caller via taskStream event
      this.send(event(this.id, entry.callerId, 'taskStream', {
        ticketId: entry.state.id,
        content,
        done,
      }));
    });

    this.on('progress', (msg: AbjectMessage) => {
      if (this._currentJobMsgId) this.resetRequestTimeout(this._currentJobMsgId);
      if (this._currentDispatchMsgId) this.resetRequestTimeout(this._currentDispatchMsgId);
      // Forward progress to JobManager so its internal callFn timeouts get reset,
      // but ONLY if this event did not originate from JobManager (avoid ping-pong loop).
      if (this.jobManagerId && msg.routing.from !== this.jobManagerId) {
        this.send(event(this.id, this.jobManagerId, 'progress', msg.payload ?? {}));
      }
    });

    // ── TupleSpace + GoalManager watcher ──
    this.on('changed', async (msg: AbjectMessage) => {
      const { aspect, value } = msg.payload as { aspect: string; value: unknown };

      // Handle GoalManager child goal events (completion, failure, task updates)
      if (aspect === 'goalCompleted' || aspect === 'goalFailed'
          || aspect === 'taskCompleted' || aspect === 'taskPermanentlyFailed') {
        this.handleChildGoalEvent(aspect, value);
        return;
      }

      // Watch both tuplePut (new tasks) and tupleUpdated (retried tasks released back to pending)
      if (aspect !== 'tuplePut' && aspect !== 'tupleUpdated') return;

      const tuple = value as { id: string; fields: Record<string, unknown>; claimedBy?: string };
      if (!tuple?.fields) {
        log.info(`WATCHER ${aspect} — no fields, skipping`);
        return;
      }

      const tupleId = tuple.id?.slice(0, 8) ?? '?';
      const status = tuple.fields.status as string ?? '?';
      const type = tuple.fields.type as string ?? '?';
      const attempts = (tuple.fields.attempts as number) ?? 0;
      const maxAttempts = (tuple.fields.maxAttempts as number) ?? 3;

      if (status !== 'pending') {
        log.info(`WATCHER ${aspect} ${tupleId} type=${type} — skip: status=${status}`);
        return;
      }
      if (tuple.claimedBy) {
        log.info(`WATCHER ${aspect} ${tupleId} type=${type} — skip: claimedBy=${tuple.claimedBy.slice(0, 8)}`);
        return;
      }
      if (attempts >= maxAttempts) {
        log.info(`WATCHER ${aspect} ${tupleId} type=${type} — skip: attempts=${attempts}>=${maxAttempts}`);
        return;
      }

      // Prevent concurrent dispatches for the same tuple
      if (this.dispatchingTuples.has(tuple.id)) {
        log.info(`WATCHER ${aspect} ${tupleId} type=${type} — skip: already dispatching`);
        return;
      }

      log.info(`WATCHER ${aspect} ${tupleId} type=${type} attempts=${attempts}/${maxAttempts} — DISPATCHING`);
      // Dispatch asynchronously — don't block the changed handler
      this.dispatchToAgent(tuple);
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Centralized Task Dispatch
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Centralized claim + dispatch for TupleSpace tasks.
   * Finds agents by taskType, filters out agents in failureHistory, optionally
   * uses LLM to pick the best agent, claims via GoalManager, sends executeTask
   * to the chosen agent, and handles success/failure.
   */
  private async dispatchToAgent(tuple: { id: string; fields: Record<string, unknown> }): Promise<void> {
    if (!this.goalManagerId) return;

    const tupleId = tuple.id.slice(0, 8);
    log.info(`DISPATCH ${tupleId} — start (dispatchingTuples size=${this.dispatchingTuples.size})`);
    this.dispatchingTuples.add(tuple.id);

    try {
      await this.dispatchToAgentInner(tuple);
      log.info(`DISPATCH ${tupleId} — completed normally`);
    } catch (err) {
      log.info(`DISPATCH ${tupleId} — threw: ${(err as Error).message?.slice(0, 120)}`);
    } finally {
      // Keep guard for 5 seconds to prevent rapid re-dispatch from CRDT sync duplicates
      log.info(`DISPATCH ${tupleId} — cooldown 5s before removing from dispatchingTuples`);
      setTimeout(() => {
        this.dispatchingTuples.delete(tuple.id);
        log.info(`DISPATCH ${tupleId} — cooldown expired, removed from dispatchingTuples`);
      }, 5000);
    }
  }

  private async dispatchToAgentInner(tuple: { id: string; fields: Record<string, unknown> }): Promise<void> {
    const tupleId = tuple.id.slice(0, 8);
    const taskType = tuple.fields.type as string;
    const description = tuple.fields.description as string;
    const data = tuple.fields.data as Record<string, unknown> | undefined;
    const taskGoalId = tuple.fields.goalId as string | undefined;
    const failureHistory = (tuple.fields.failureHistory as Array<{ agent: string; agentId: string }>) ?? [];

    log.info(`DISPATCH-INNER ${tupleId} type=${taskType} goalId=${taskGoalId?.slice(0, 8) ?? '?'} failureHistory=${failureHistory.length}`);

    // 1. Find agents whose taskTypes include this task type
    const candidates = [...this.registeredAgents.values()]
      .filter(a => a.taskTypes.includes(taskType));

    const failedAgentIds = new Set(failureHistory.map(f => f.agentId));
    let eligibleCandidates: RegisteredAgent[];

    if (candidates.length === 0) {
      // No exact type match — try semantic fallback via LLM
      const allAgents = [...this.registeredAgents.values()]
        .filter(a => !failedAgentIds.has(a.agentId))
        .filter(a => !this.busyAgents.has(a.agentId));
      if (allAgents.length === 0) {
        log.info(`DISPATCH-INNER ${tupleId} — no registered agents available for fallback (failed or busy)`);
        return;
      }
      const matched = await this.semanticMatchAgent(allAgents, taskType, description);
      if (!matched) {
        log.info(`DISPATCH-INNER ${tupleId} — LLM fallback found no suitable agent for type=${taskType}`);
        return;
      }
      log.info(`DISPATCH-INNER ${tupleId} — LLM fallback matched: ${matched.name}`);
      eligibleCandidates = [matched];
    } else {
      // Exact type match — filter out failed and busy agents
      eligibleCandidates = candidates
        .filter(a => !failedAgentIds.has(a.agentId))
        .filter(a => !this.busyAgents.has(a.agentId));
      if (eligibleCandidates.length === 0) {
        log.info(`DISPATCH-INNER ${tupleId} — all ${candidates.length} agents failed or busy`);
        return;
      }
    }

    // 3. Pick the best agent
    let chosen: RegisteredAgent;
    if (eligibleCandidates.length === 1) {
      chosen = eligibleCandidates[0];
    } else {
      chosen = await this.classifyBestAgent(eligibleCandidates, description);
    }

    // 3a. Mark agent busy BEFORE the async claim to prevent concurrent
    // dispatches from claiming tasks for the same agent (JS is single-threaded,
    // so this is visible to any dispatch that runs between our await points).
    if (this.busyAgents.has(chosen.agentId)) {
      log.info(`DISPATCH-INNER ${tupleId} — agent ${chosen.name} became busy, aborting before claim`);
      return;
    }
    this.busyAgents.add(chosen.agentId);

    // 4. Claim via GoalManager
    log.info(`DISPATCH-INNER ${tupleId} — claiming for ${chosen.name}`);
    let claimed: { tuple: { id: string; fields: Record<string, unknown> }; claimed: boolean } | null;
    try {
      claimed = await this.request<{ tuple: { id: string; fields: Record<string, unknown> }; claimed: boolean } | null>(
        request(this.id, this.goalManagerId!, 'claimTask', {
          goalId: taskGoalId,
          type: taskType,
        })
      );
    } catch (err) {
      log.info(`DISPATCH-INNER ${tupleId} — claim failed: ${(err as Error).message}`);
      this.busyAgents.delete(chosen.agentId);
      return;
    }

    if (!claimed) {
      log.info(`DISPATCH-INNER ${tupleId} — no claimable tuple found`);
      this.busyAgents.delete(chosen.agentId);
      return;
    }
    log.info(`DISPATCH-INNER ${tupleId} — claimed, sending executeTask to ${chosen.name}`);

    // 5. Report progress (attempts are tracked by failTask, not here)
    if (taskGoalId) {
      this.send(event(this.id, this.goalManagerId!, 'updateProgress', {
        goalId: taskGoalId,
        message: `${chosen.name} claiming task: ${description.slice(0, 60)}`,
        phase: 'dispatch',
        agentName: 'AgentAbject',
      }));
    }

    // 6. Route executeTask through JobManager so it appears in the Jobs panel
    const dispatchStart = Date.now();
    const executePayload = {
      tupleId: claimed.tuple.id,
      goalId: taskGoalId,
      description,
      data,
      type: taskType,
      callerId: this.id,
    };
    const jobCode = `return await call(${JSON.stringify(chosen.agentId)}, 'executeTask', ${JSON.stringify(executePayload)});`;
    const jobMgrId = await this.resolveDep('JobManager', this.jobManagerId);
    const submitMsg = request(this.id, jobMgrId, 'submitJob', {
      description: `[${chosen.name}] ${description.slice(0, 80)}`,
      code: jobCode,
      queue: chosen.name,
    });
    this._currentDispatchMsgId = submitMsg.header.messageId;

    // Heartbeat: send periodic progress while the job is queued/running so that
    // upstream waitForTaskCompletion timeouts in Chat get reset.
    const heartbeat = setInterval(() => {
      if (taskGoalId && this.goalManagerId) {
        this.send(event(this.id, this.goalManagerId, 'updateProgress', {
          goalId: taskGoalId,
          message: `${chosen.name} working...`,
          phase: 'dispatch',
          agentName: 'AgentAbject',
        }));
      }
    }, 30000);

    try {
      const jobResult = await this.request<JobResult>(submitMsg, 400000);
      if (jobResult.status === 'failed') throw new Error(jobResult.error ?? 'Job failed');
      const result = jobResult.result;

      const elapsed = Date.now() - dispatchStart;
      log.info(`DISPATCH-INNER ${tupleId} — executeTask SUCCESS (${elapsed}ms), completing task`);

      // 7. Check result — fail, watch child goal, or complete
      const resultObj = result as Record<string, unknown> | undefined;
      if (resultObj && resultObj.success === false) {
        // Agent returned an explicit failure (e.g. "Object not found") — treat as failTask so it can retry
        const errorMsg = (resultObj.error as string) ?? 'Task returned success: false';
        log.info(`DISPATCH-INNER ${tupleId} — executeTask returned failure: ${errorMsg.slice(0, 120)}`);
        try {
          await this.request(
            request(this.id, this.goalManagerId!, 'failTask', {
              taskId: claimed.tuple.id,
              goalId: taskGoalId,
              error: errorMsg,
              agentName: chosen.name,
              agentId: chosen.agentId,
            })
          );
        } catch (err2) {
          log.info(`DISPATCH-INNER ${tupleId} — failTask also failed: ${(err2 as Error).message?.slice(0, 80)}`);
        }
      } else if (resultObj && resultObj.childGoalId) {
        log.info(`DISPATCH-INNER ${tupleId} — task spawned child goal ${(resultObj.childGoalId as string).slice(0, 8)}, watching`);
        this.watchChildGoal(resultObj.childGoalId as string, claimed.tuple.id, taskGoalId!);
      } else {
        await this.request(
          request(this.id, this.goalManagerId!, 'completeTask', {
            taskId: claimed.tuple.id,
            goalId: taskGoalId,
            result,
          })
        );
        log.info(`DISPATCH-INNER ${tupleId} — task completed`);
      }
    } catch (err) {
      const elapsed = Date.now() - dispatchStart;
      log.info(`DISPATCH-INNER ${tupleId} — executeTask FAILED (${elapsed}ms): ${(err as Error).message?.slice(0, 120)}`);
      // 8. Fail task with agent identity for history tracking
      try {
        await this.request(
          request(this.id, this.goalManagerId!, 'failTask', {
            taskId: claimed.tuple.id,
            goalId: taskGoalId,
            error: (err as Error).message,
            agentName: chosen.name,
            agentId: chosen.agentId,
          })
        );
        log.info(`DISPATCH-INNER ${tupleId} — failTask sent`);
      } catch (err2) {
        log.info(`DISPATCH-INNER ${tupleId} — failTask also failed: ${(err2 as Error).message?.slice(0, 80)}`);
      }
    } finally {
      clearInterval(heartbeat);
      this._currentDispatchMsgId = undefined;
      this.busyAgents.delete(chosen.agentId);
      // Immediate re-scan: pick up next pending task for this now-free agent
      this.periodicScan().catch(() => {});
    }
  }

  /**
   * Scan TupleSpace for pending/unclaimed tasks and dispatch eligible ones.
   * Catches tasks missed during cooldown, pre-existing at boot, or lost events.
   * Queries GoalManager for active top-level goals and scans each namespace.
   */
  private async periodicScan(): Promise<void> {
    if (!this.tupleSpaceId || !this.goalManagerId) return;

    try {
      const goals = await this.request<Array<{ id: string; parentId?: string }>>(
        request(this.id, this.goalManagerId, 'listGoals', { status: 'active' })
      );
      const topLevel = goals.filter(g => !g.parentId);
      for (const goal of topLevel) {
        await this.scanNamespace(goal.id);
      }
    } catch (err) {
      log.info(`SCAN failed: ${(err as Error).message?.slice(0, 120)}`);
    }
  }

  private async scanNamespace(namespace: string): Promise<void> {
    if (!this.tupleSpaceId) return;
    try {
      const tuples = await this.request<Array<{ id: string; fields: Record<string, unknown>; claimedBy?: string }>>(
        request(this.id, this.tupleSpaceId, 'scan', {
          namespace,
          pattern: { status: 'pending' },
        })
      );

      let dispatched = 0;
      for (const tuple of tuples) {
        if (tuple.claimedBy) continue;
        const attempts = (tuple.fields.attempts as number) ?? 0;
        const maxAttempts = (tuple.fields.maxAttempts as number) ?? 3;
        if (attempts >= maxAttempts) continue;
        if (this.dispatchingTuples.has(tuple.id)) continue;

        log.info(`SCAN ${tuple.id.slice(0, 8)} type=${tuple.fields.type ?? '?'} attempts=${attempts}/${maxAttempts} — DISPATCHING`);
        this.dispatchToAgent(tuple);
        dispatched++;
      }
      if (dispatched > 0) {
        log.info(`SCAN dispatched ${dispatched} pending task(s) from ns=${namespace.slice(0, 8)}`);
      }
    } catch (err) {
      log.info(`SCAN ns=${namespace.slice(0, 8)} failed: ${(err as Error).message?.slice(0, 120)}`);
    }
  }

  /**
   * Use a short LLM call to classify which agent is best suited for a task.
   * Falls back to the first candidate if LLM is unavailable or fails.
   */
  private async classifyBestAgent(candidates: RegisteredAgent[], description: string): Promise<RegisteredAgent> {
    if (!this.llmId) return candidates[0];

    const agentList = candidates.map((a, i) => `${i}: ${a.name} — ${a.description}`).join('\n');
    const prompt = `Given this task: "${description.slice(0, 200)}"

Which agent is best suited? Pick one by index number.

Agents:
${agentList}

Reply with ONLY the index number (e.g. "0" or "1").`;

    try {
      const result = await this.request<{ content: string }>(
        request(this.id, this.llmId, 'complete', {
          messages: [{ role: 'user', content: prompt }],
          options: { maxTokens: 20 },
        }),
        10000,
      );
      const content = result.content ?? '';
      const idx = parseInt(content.trim(), 10);
      if (!isNaN(idx) && idx >= 0 && idx < candidates.length) {
        return candidates[idx];
      }
    } catch (err) {
      log.warn(`classifyBestAgent LLM failed, using first candidate:`, err instanceof Error ? err.message : String(err));
    }

    return candidates[0];
  }

  /**
   * Semantic fallback: when no agent declares the task type, ask the LLM
   * which registered agent (if any) can handle it based on descriptions.
   */
  private async semanticMatchAgent(
    allAgents: RegisteredAgent[],
    taskType: string,
    description: string,
  ): Promise<RegisteredAgent | null> {
    if (!this.llmId) return null;

    const agentList = allAgents
      .map((a, i) => `${i}: ${a.name} (types: ${a.taskTypes.join(', ')}) — ${a.description}`)
      .join('\n');
    const prompt = `No agent explicitly declares task type "${taskType}".
Task description: "${description.slice(0, 200)}"

Based on the agent descriptions below, which agent (if any) could handle this task?

Agents:
${agentList}

Reply with ONLY the index number of the best match, or "none" if no agent is suitable.`;

    try {
      const result = await this.request<{ content: string }>(
        request(this.id, this.llmId, 'complete', {
          messages: [{ role: 'user', content: prompt }],
          options: { maxTokens: 20 },
        }),
        10000,
      );
      const content = (result.content ?? '').trim().toLowerCase();
      if (content === 'none') return null;
      const idx = parseInt(content, 10);
      if (!isNaN(idx) && idx >= 0 && idx < allAgents.length) {
        return allAgents[idx];
      }
    } catch (err) {
      log.warn(`semanticMatchAgent LLM failed, no match:`, err instanceof Error ? err.message : String(err));
    }

    return null;
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
    }));

    // Always forward progress to ticket caller (even if caller is the agent itself —
    // agentPhaseChanged and taskProgress are distinct event types, no duplication)
    this.send(event(this.id, entry.callerId, 'taskProgress', {
      ticketId: entry.state.id,
      step: entry.state.step,
      maxSteps: entry.state.maxSteps,
      phase: newPhase,
      action: entry.state.action?.action,
    }));

    // Update goal progress via GoalManager
    if (entry.goalId && this.goalManagerId) {
      const agentName = this.registeredAgents.get(entry.agentId)?.name ?? 'Agent';
      const msg = newPhase === 'acting' && entry.state.action?.action
        ? `${entry.state.action.action}...`
        : `${newPhase} (step ${entry.state.step + 1}/${entry.state.maxSteps})`;
      this.send(event(this.id, this.goalManagerId, 'updateProgress', {
        goalId: entry.goalId,
        message: msg,
        phase: newPhase,
        agentName,
      }));
    }
  }

  private emitIntermediateAction(entry: TaskEntry): void {
    this.send(event(this.id, entry.agentId, 'agentIntermediateAction', {
      taskId: entry.state.id,
      action: entry.state.action,
    }));
  }

  private emitActionResult(entry: TaskEntry): void {
    this.send(event(this.id, entry.agentId, 'agentActionResult', {
      taskId: entry.state.id,
      action: entry.state.action,
      result: entry.state.lastResult,
    }));
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

    // Complete or fail the goal via GoalManager
    if (entry.goalId && this.goalManagerId) {
      if (success) {
        this.send(event(this.id, this.goalManagerId, 'completeGoal', {
          goalId: entry.goalId,
          result: entry.state.result,
        }));
      } else {
        this.send(event(this.id, this.goalManagerId, 'failGoal', {
          goalId: entry.goalId,
          error: entry.state.error,
        }));
      }
    }

    // Send taskResult event to the ticket holder (caller)
    this.send(event(this.id, entry.callerId, 'taskResult', {
      ticketId: entry.state.id,
      success,
      result: entry.state.result,
      error: entry.state.error,
      steps: entry.state.step,
      maxStepsReached: entry.state.step >= entry.state.maxSteps,
      validationErrors,
      lastAction: entry.state.action,
    }));

    this.changed('taskCompleted', {
      taskId: entry.state.id,
      agentId: entry.agentId,
      success,
      result: success ? entry.state.result : undefined,
      error: success ? undefined : entry.state.error,
    });
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

            // If there are active child goals, wait for next event then check status
            if (entry.childGoalIds && entry.childGoalIds.length > 0 && this.goalManagerId) {
              const statusLines: string[] = [];
              const stillActive: string[] = [];

              for (const cgId of entry.childGoalIds) {
                try {
                  const goal = await this.request<{ id: string; status: string; title: string; result?: unknown; error?: string } | null>(
                    request(this.id, this.goalManagerId, 'getGoal', { goalId: cgId }),
                  );
                  if (!goal) continue;

                  if (goal.status === 'completed' || goal.status === 'failed') {
                    statusLines.push(goal.status === 'completed'
                      ? `[Child Goal "${goal.title}"] COMPLETED: ${JSON.stringify(goal.result)?.slice(0, 300)}`
                      : `[Child Goal "${goal.title}"] FAILED: ${goal.error ?? 'unknown'}`);
                    continue;
                  }

                  // Active — check task progress
                  const tasks = await this.request<Array<{ id: string; fields: Record<string, unknown> }>>(
                    request(this.id, this.goalManagerId, 'getTasksForGoal', { goalId: cgId }),
                  );
                  const doneT = tasks.filter(t => t.fields.status === 'done');
                  const pending = tasks.filter(t => t.fields.status === 'pending');
                  const inProgress = tasks.filter(t => t.fields.claimedBy);
                  const permFailed = tasks.filter(t => t.fields.status === 'permanently_failed');

                  // Agent decides: all tasks done → complete the child goal
                  if (pending.length === 0 && inProgress.length === 0 && doneT.length > 0) {
                    const results = doneT.map(t => ({
                      type: t.fields.type, description: t.fields.description, result: t.fields.result,
                    }));
                    await this.request(request(this.id, this.goalManagerId, 'completeGoal', {
                      goalId: cgId, result: results,
                    }));
                    statusLines.push(`[Child Goal "${goal.title}"] COMPLETED (${doneT.length} tasks): ${JSON.stringify(results)?.slice(0, 300)}`);
                  } else if (pending.length === 0 && inProgress.length === 0 && permFailed.length > 0 && doneT.length === 0) {
                    // All tasks permanently failed → fail the child goal
                    await this.request(request(this.id, this.goalManagerId, 'failGoal', {
                      goalId: cgId, error: `All ${permFailed.length} tasks permanently failed`,
                    }));
                    statusLines.push(`[Child Goal "${goal.title}"] FAILED: all tasks permanently failed`);
                  } else {
                    // Still in progress — keep tracking
                    stillActive.push(cgId);
                    statusLines.push(`[Child Goal "${goal.title}"] ${doneT.length}/${tasks.length} tasks done, ${pending.length} pending`);
                  }
                } catch { /* best effort */ }
              }

              entry.childGoalIds = stillActive;

              // If any child goals still active, wait for next event before thinking
              if (stillActive.length > 0) {
                log.info(`[${agentName}] Waiting for child goal event...`);
                await this.waitForChildGoalEvent(stillActive, entry.state.timeout);
                // Re-check status will happen on next observe cycle
              }

              // Inject child goal status into observation
              task.observation = (task.observation ?? '') + '\n\n' + statusLines.join('\n');
            }

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

            // ── Decompose: create child goal + tasks, return to observing ──
            if (task.action.action === 'decompose') {
              const subtasks = task.action.subtasks as Array<{
                type: string; description: string; data?: unknown;
              }>;
              if (!subtasks?.length) {
                task.llmMessages.push({
                  role: 'user',
                  content: '[Error] decompose requires a non-empty "subtasks" array.',
                });
                break; // re-enter thinking
              }
              if (!this.goalManagerId || !entry.goalId) {
                task.llmMessages.push({
                  role: 'user',
                  content: '[Error] Cannot decompose — GoalManager not available.',
                });
                break;
              }

              // Resolve object names to IDs for modify subtasks
              for (const sub of subtasks) {
                if (sub.type === 'modify' && sub.data) {
                  const d = sub.data as Record<string, unknown>;
                  if (d.object && !d.objectId) {
                    const resolved = await this.discoverDep(d.object as string);
                    if (resolved) d.objectId = resolved;
                  }
                }
              }

              log.info(`[${agentName}] Decomposing into ${subtasks.length} sub-tasks`);
              try {
                const childGoalId = await this.createChildGoalWithTasks(entry, subtasks, agentName);
                if (!entry.childGoalIds) entry.childGoalIds = [];
                entry.childGoalIds.push(childGoalId);
              } catch (err) {
                task.llmMessages.push({
                  role: 'user',
                  content: `[Decomposition Error] ${err instanceof Error ? err.message : String(err)}`,
                });
              }
              task.step++;
              if (task.step >= task.maxSteps) {
                await this.handleMaxStepsReached(entry, agentName, setPhase);
                break;
              }
              // Back to observing — the event-driven wait will kick in
              setPhase('observing');
              break;
            }

            // ── Replan: clear state, re-observe ──
            if (task.action.action === 'replan') {
              task.plan = undefined;
              task.step++;
              if (task.step >= task.maxSteps) {
                await this.handleMaxStepsReached(entry, agentName, setPhase);
                break;
              }
              setPhase('observing');
              break;
            }

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
                await this.handleMaxStepsReached(entry, agentName, setPhase);
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
              await this.handleMaxStepsReached(entry, agentName, setPhase);
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
  // Max-steps handling: forced final LLM call + salvage fallback
  // ═══════════════════════════════════════════════════════════════════

  /**
   * When the step budget is exhausted, attempt to salvage a result:
   * 1. Make one forced final LLM call asking the model to synthesize a "done"
   *    response from everything it has gathered so far (inspired by LangChain's
   *    early_stopping_method="generate" and CrewAI's "requesting final answer").
   * 2. If the forced call produces a terminal "done" action, use it.
   * 3. Otherwise fall back to salvaging the last successful action result.
   * 4. If nothing is salvageable, set phase to error.
   */
  private async handleMaxStepsReached(
    entry: TaskEntry,
    agentName: string,
    setPhase: (p: AgentPhase) => void,
  ): Promise<void> {
    const task = entry.state;
    log.info(`[${agentName}] Max steps (${task.maxSteps}) reached — attempting forced final LLM call`);

    // Try one final LLM call to synthesize accumulated data
    try {
      task.llmMessages.push({
        role: 'user',
        content: `[BUDGET EXHAUSTED — Final Step]\nYou have used all ${task.maxSteps} steps. You MUST respond with a "done" or "fail" action NOW.\nIf you have extracted ANY useful data during this task, respond with:\n\`\`\`json\n{"action": "done", "result": <your best result so far>}\n\`\`\`\nOtherwise respond with:\n\`\`\`json\n{"action": "fail", "reason": "Could not complete task in ${task.maxSteps} steps"}\n\`\`\``,
      });

      this.trimConversation(entry);

      this.llmId = await this.resolveDep('LLM', this.llmId);
      const llmResult = await this.request<{ content: string }>(
        request(this.id, this.llmId, 'complete', {
          messages: task.llmMessages,
          options: { tier: 'balanced', maxTokens: 2048 },
        }),
        60000,
      );

      task.llmMessages.push({ role: 'assistant', content: llmResult.content });

      const parsed = this.parseAction(entry, llmResult.content);
      log.info(`[${agentName}] Forced final LLM response: ${parsed.action}`);

      const terminal = this.isTerminalAction(entry, parsed);
      if (terminal === 'success') {
        setPhase('done');
        log.info(`[${agentName}] Max steps reached — forced LLM call produced a result`);
        return;
      }
      if (terminal === 'error') {
        setPhase('error');
        return;
      }
      // LLM didn't produce a terminal action — fall through to salvage
    } catch (err) {
      log.warn(`[${agentName}] Forced final LLM call failed: ${err instanceof Error ? err.message : String(err)}`);
      // Fall through to salvage logic
    }

    // Fallback: salvage last successful action result
    if (task.lastResult?.success && task.lastResult.data != null && task.lastResult.data !== '') {
      task.result = task.lastResult.data;
      task.error = `Max steps (${task.maxSteps}) reached — returning last successful result`;
      setPhase('done');
      log.info(`[${agentName}] Max steps reached — salvaging last successful result`);
    } else {
      setPhase('error');
      task.error = `Max steps (${task.maxSteps}) reached`;
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
      // Prepend goal helper closures so job code can update goals
      const goalPreamble = entry.goalId && this.goalManagerId
        ? `const _goalId = '${entry.goalId}';
           const _goalMgrId = '${this.goalManagerId}';
           const getGoal = async () => call(_goalMgrId, 'getGoal', { goalId: _goalId });
           const updateGoal = async (message, phase) => call(_goalMgrId, 'updateProgress', { goalId: _goalId, message, phase });
           const completeGoal = async (result) => call(_goalMgrId, 'completeGoal', { goalId: _goalId, result });
           const failGoal = async (error) => call(_goalMgrId, 'failGoal', { goalId: _goalId, error });
           const addTask = async (type, description, data) => call(_goalMgrId, 'addTask', { goalId: _goalId, type, description, data });
           const claimTask = async (type) => call(_goalMgrId, 'claimTask', { goalId: _goalId, type });
           const completeTask = async (taskId, result) => call(_goalMgrId, 'completeTask', { taskId, result });
           const failTask = async (taskId, error) => call(_goalMgrId, 'failTask', { taskId, error });
           const getTasksForGoal = async (status) => call(_goalMgrId, 'getTasksForGoal', { goalId: _goalId, status });
          `
        : `const getGoal = async () => null;
           const updateGoal = async () => {};
           const completeGoal = async () => {};
           const failGoal = async () => {};
           const addTask = async () => null;
           const claimTask = async () => null;
           const completeTask = async () => false;
           const failTask = async () => false;
           const getTasksForGoal = async () => [];
          `;
      const fullCode = goalPreamble + code;

      const jobMgrId = await this.resolveDep('JobManager', this.jobManagerId);
      const submitMsg = request(this.id, jobMgrId, 'submitJob', {
        description,
        code: fullCode,
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
        // If the agent's callback returned an AgentActionResult-shaped object
        // (with its own success/error), unwrap it so the caller sees the real
        // success status rather than always getting success: true from the job.
        const r = jobResult.result as Record<string, unknown> | undefined;
        if (r && typeof r === 'object' && typeof r.success === 'boolean') {
          return {
            success: r.success as boolean,
            data: r.data ?? r.result,
            error: r.error as string | undefined,
          };
        }
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
    // Use streaming — llmChunk events are forwarded to the ticket caller
    this.activeStreamEntry = entry;
    let llmResult: { content: string };
    try {
      llmResult = await this.request<{ content: string }>(
        request(this.id, this.llmId, 'stream', {
          messages: task.llmMessages,
          options: { tier: 'balanced', maxTokens: 2048 },
        }),
        120000,
      );
    } finally {
      this.activeStreamEntry = undefined;
    }

    // Add assistant response
    task.llmMessages.push({ role: 'assistant', content: llmResult.content });

    const agentName = this.registeredAgents.get(entry.agentId)?.name ?? 'Unknown';
    const parsed = this.parseAction(entry, llmResult.content);
    log.info(`[${agentName}] Step ${task.step + 1} — LLM action: ${parsed.action}${parsed.reasoning ? ' (' + parsed.reasoning.slice(0, 60) + ')' : ''}`);
    return parsed;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Child Goal Watching
  // ═══════════════════════════════════════════════════════════════════

  /** Maps child goal ID → { parentTaskId, parentGoalId } for completion tracking. */
  private watchedChildGoals = new Map<string, { parentTaskId: string; parentGoalId: string }>();

  private watchChildGoal(childGoalId: string, parentTaskId: string, parentGoalId: string): void {
    this.watchedChildGoals.set(childGoalId, { parentTaskId, parentGoalId });
  }

  /**
   * Called from the `changed` handler when GoalManager emits goalCompleted/goalFailed/taskCompleted/taskPermanentlyFailed.
   * Resolves event waiters (from observe phase) and handles dispatch-level child goal watching.
   */
  private handleChildGoalEvent(aspect: string, value: unknown): void {
    if (aspect !== 'goalCompleted' && aspect !== 'goalFailed'
        && aspect !== 'taskCompleted' && aspect !== 'taskPermanentlyFailed') return;

    const { goalId, taskId, result, error } = value as {
      goalId: string; taskId?: string; result?: unknown; error?: string;
    };

    // Resolve event waiters (from observe phase waiting on child goals)
    const resolver = this.childGoalEventResolvers.get(goalId);
    if (resolver) {
      resolver.resolve({ aspect, goalId, taskId, result, error });
      // resolve callback cleans up all resolvers in the wait group
    }

    // Existing dispatch-level child goal watching (unchanged)
    const watched = this.watchedChildGoals.get(goalId);
    if (!watched) return;
    this.watchedChildGoals.delete(goalId);

    if (aspect === 'goalCompleted') {
      this.request(request(this.id, this.goalManagerId!, 'completeTask', {
        taskId: watched.parentTaskId, result, goalId: watched.parentGoalId,
      }));
    } else if (aspect === 'goalFailed') {
      this.request(request(this.id, this.goalManagerId!, 'failTask', {
        taskId: watched.parentTaskId, error: error ?? 'Child goal failed', goalId: watched.parentGoalId,
      }));
    }
  }

  /**
   * Wait for the next event related to any of the child goals.
   * Resolved by handleChildGoalEvent when a matching event arrives.
   */
  private waitForChildGoalEvent(
    childGoalIds: string[],
    timeoutMs: number,
  ): Promise<{ aspect: string; goalId: string; taskId?: string; result?: unknown; error?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        for (const id of childGoalIds) this.childGoalEventResolvers.delete(id);
        resolve({ aspect: 'timeout', goalId: childGoalIds[0] ?? '' });
      }, timeoutMs);

      for (const id of childGoalIds) {
        this.childGoalEventResolvers.set(id, {
          resolve: (evt) => {
            clearTimeout(timer);
            // Clean up all resolvers for this wait group
            for (const gid of childGoalIds) this.childGoalEventResolvers.delete(gid);
            resolve(evt);
          },
          timer,
        });
      }
    });
  }

  /**
   * Create a child goal with tasks for the decompose action.
   */
  private async createChildGoalWithTasks(
    entry: TaskEntry,
    subtasks: Array<{ type: string; description: string; data?: unknown }>,
    agentName: string,
  ): Promise<string> {
    const goalMgrId = this.goalManagerId!;
    const summary = (entry.state.action?.reasoning as string)
      ?? `Decomposed: ${subtasks.map(s => s.description).join(', ').slice(0, 100)}`;

    const { goalId: childGoalId } = await this.request<{ goalId: string }>(
      request(this.id, goalMgrId, 'createGoal', {
        title: summary.slice(0, 200),
        parentId: entry.goalId,
      }),
    );
    log.info(`[${agentName}] Child goal ${childGoalId.slice(0, 8)} with ${subtasks.length} tasks`);

    const taskIds: string[] = [];
    for (const sub of subtasks) {
      const { taskId } = await this.request<{ taskId: string }>(
        request(this.id, goalMgrId, 'addTask', {
          goalId: childGoalId, type: sub.type,
          description: sub.description, data: sub.data,
        }),
      );
      taskIds.push(taskId);
    }

    // Store plan on child goal for visibility
    this.send(event(this.id, goalMgrId, 'updatePlan', {
      goalId: childGoalId,
      plan: {
        summary,
        steps: subtasks.map((s, i) => ({
          id: `step-${i + 1}`, description: s.description,
          taskType: s.type, taskId: taskIds[i], data: s.data,
        })),
        revision: 0,
      },
    }));

    return childGoalId;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Conversation Management
  // ═══════════════════════════════════════════════════════════════════

  private initializeConversation(entry: TaskEntry): { role: string; content: string | ContentPart[] }[] {
    const messages: { role: string; content: string | ContentPart[] }[] = [];

    let prompt = entry.systemPrompt;
    if (entry.skillPromptSuffix) {
      prompt += entry.skillPromptSuffix;
    }
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

    const stepsRemaining = task.maxSteps - task.step;
    const urgency = stepsRemaining <= 2
      ? `\n⚠️ LAST STEP — you MUST call "done" now with whatever data you have. No more actions after this.`
      : stepsRemaining <= 5
        ? `\n⚠️ WARNING: Only ${stepsRemaining} steps remaining! Wrap up and call "done" soon.`
        : '';

    // If agent provided llmContent (e.g. screenshot), use it directly
    if (entry.lastObservationLlmContent) {
      // Prepend step info to the first text part
      const content = entry.lastObservationLlmContent.map((part, i) => {
        if (i === 0 && part.type === 'text') {
          return { ...part, text: `[Step ${task.step + 1}/${task.maxSteps}]${urgency}\n${part.text}` };
        }
        return part;
      });
      task.llmMessages.push({
        role: 'user',
        content,
      });
      entry.lastObservationLlmContent = undefined;
      return;
    }

    task.llmMessages.push({
      role: 'user',
      content: `[Step ${task.step + 1}/${task.maxSteps}]${urgency}\n${task.observation}`,
    });
  }

  private addActionResultToConversation(entry: TaskEntry): void {
    const task = entry.state;
    if (!task.lastResult) return;

    const action = task.action;
    const resultStr = task.lastResult.success
      ? `Action "${action?.action}" succeeded: ${JSON.stringify(task.lastResult.data)?.slice(0, 500) ?? 'ok'}`
      : `Action "${action?.action}" failed: ${task.lastResult.error}`;

    let hint = '';
    if (!task.lastResult.success && action?.action === 'modify') {
      hint = '\n\nThe object still exists. You MUST retry with "modify" (try a simpler description), or report the failure to the user with "done". Do NOT use "create" -- that would produce a duplicate.';
    }
    task.llmMessages.push({ role: 'user', content: `[Action Result]\n${resultStr}${hint}` });
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

    // Detect hallucinated tool calls -- these are never valid results
    const hallucinationPatterns = ['<function_calls>', '<tool_call>', '<invoke name='];
    if (hallucinationPatterns.some(p => content.includes(p))) {
      return { action: 'fail', reason: 'LLM hallucinated tool calls instead of producing a valid action' };
    }

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
