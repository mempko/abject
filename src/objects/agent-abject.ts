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
import { PROFILE_TAG } from './knowledge-base.js';
import type { ContentPart } from '../llm/provider.js';
import { truncateText, conversationTextChars, enforceConversationCharBudget } from '../llm/provider.js';
import type { TierCapabilities } from './llm-object.js';
import type { EnabledSkillSummary } from '../core/skill-types.js';
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
  /** Rolling log of action signatures (action:target:method:errorClass) for loop detection. */
  actionHistory?: string[];
  /** Signatures already nudged about, so the loop-detection steer fires once per pattern. */
  nudgedSignatures?: string[];
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
  /** Whether this agent can execute tasks from TupleSpace. Agents that only create tasks (like Chat) set this to false. */
  canExecute: boolean;
  registeredAt: number;
}

/**
 * One task queued for execution on a specific agent. A QueuedTask carries
 * everything needed to call `startTask` when the agent's queue runner pops it
 * — meaning the queue is a simple buffer of fully-prepared task descriptions,
 * not a planning surface. ScrumMaster fills queues from each scrum's plan;
 * AgentAbject pops from each queue one task at a time per agent.
 */
interface QueuedTask {
  taskId: string;
  task: string;
  systemPrompt?: string;
  initialMessages?: { role: string; content: string | ContentPart[] }[];
  config?: Partial<AgentConfig>;
  responseSchema?: Record<string, unknown>;
  goalId?: string;
  dispatchTupleId?: string;
  callerId: AbjectId;
  enqueuedAt: number;
  /**
   * Opaque task-specific data forwarded to the agent's executeTask `data`
   * field (e.g. ScrumMaster passes `{ target }` so an authoring agent works
   * on a known existing object). AgentAbject does not interpret it.
   */
  data?: Record<string, unknown>;
}

interface TaskEntry {
  state: AgentTaskState;
  agentId: AbjectId;
  callerId: AbjectId;
  config: ResolvedAgentConfig;
  systemPrompt: string;
  initialMessages?: { role: string; content: string | ContentPart[] }[];
  lastObservationLlmContent?: ContentPart[];
  /** LLM tier hint from the last observe callback (e.g. 'fast', 'balanced'). */
  observeTier?: string;
  /** JSON Schema for structured result validation. */
  responseSchema?: Record<string, unknown>;
  /** Goal ID for cross-agent progress tracking via GoalManager. */
  goalId?: string;
  /** Set when task came from dispatch (the parent goal). */
  incomingGoalId?: string;
  /** Cached skill instructions appended to system prompt. */
  skillPromptSuffix?: string;
  /**
   * KnowledgeBase entries injected into this task's system prompt at init.
   * The post-task reviewer reads these to judge which entries actually
   * helped (markUseful), closing the usefulness feedback loop.
   */
  injectedKnowledge?: Array<{ id: string; title: string }>;
  /** Compact "tag (count), ..." line of the KB's tag vocabulary at init. */
  knownTagsLine?: string;
  /**
   * Set when the state machine has actually exited. Cancellation flips
   * state.phase to 'error' while the loop may still be parked in an await,
   * so phase alone can't authorize releasing or reviewing the entry; a
   * released-under-running-machine entry makes the zombie's next step throw
   * and re-fire terminal signals for a deleted task.
   */
  finished?: boolean;
  /** TupleSpace tuple id of the goal task this entry is executing (when dispatched). Enables scratchpad contract injection for the current task. */
  dispatchTupleId?: string;
  /** Consecutive LLM responses that failed to parse into a valid action. Reset on every successful parse. */
  parseFailures?: number;
  /** Consecutive LLM streams that returned empty content. Reset on every non-empty response. */
  emptyResponses?: number;
  /** Consecutive truncated terminal responses (cut off mid-generation). Reset on every complete response. */
  truncationRetries?: number;
  /** Actions 2..N from a multi-action LLM response, drained in order by the thinking phase without an LLM round-trip between them. Replaced on every parse; discarded on failure or max-steps. */
  pendingActions?: AgentAction[];
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

/**
 * Injection-time hygiene for always-injected profile facts. A fact whose
 * content reads like an instruction to the model (rather than a statement
 * about the user) is a memory-poisoning vector: an agent that "remembered"
 * text from a hostile web page would otherwise smuggle directives into every
 * future system prompt. The stored entry is left untouched so the user can
 * inspect and restore or delete it in the knowledge browser.
 */
const SUSPICIOUS_FACT_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+|any\s+)?(previous|prior|above|earlier)\s+(instructions|prompts|rules)/i,
  /disregard\s+(your|the|all)\s+(instructions|system\s+prompt|rules|guidelines)/i,
  /you\s+(must|should|will)\s+now\s+/i,
  /new\s+(system\s+)?instructions?\s*:/i,
  /\bsystem\s+prompt\b/i,
  /do\s+not\s+(tell|inform|reveal|mention)\s+(the\s+)?user/i,
  /\bexfiltrat/i,
  /always\s+(respond|reply|answer)\s+with\b/i,
];

function sanitizeInjectedFact(content: string): string {
  for (const pattern of SUSPICIOUS_FACT_PATTERNS) {
    if (pattern.test(content)) {
      return '[BLOCKED: this entry looks like an instruction rather than a fact about the user; inspect it in the knowledge browser]';
    }
  }
  return content;
}

/**
 * Flatten a task's LLM conversation into one reviewable string. Non-text
 * content parts collapse to type markers; the middle is elided when the
 * whole transcript exceeds the cap so head (task setup) and tail (outcome)
 * both survive.
 */
const TRANSCRIPT_CHAR_CAP = 40000;

function flattenTranscript(messages: { role: string; content: string | ContentPart[] }[]): string {
  const lines = messages.map(m => {
    const text = typeof m.content === 'string'
      ? m.content
      : m.content.map(p => (p.type === 'text' ? p.text : `[${p.type}]`)).join(' ');
    return `[${m.role}] ${text}`;
  });
  let out = lines.join('\n\n');
  if (out.length > TRANSCRIPT_CHAR_CAP) {
    const head = out.slice(0, TRANSCRIPT_CHAR_CAP * 0.6);
    const tail = out.slice(-TRANSCRIPT_CHAR_CAP * 0.35);
    out = `${head}\n\n[... transcript middle elided ...]\n\n${tail}`;
  }
  return out;
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

  /** Last time we forwarded a low-level progress signal as GoalManager.updateProgress per goal. */
  private lastGoalProgressTs = new Map<string, number>();
  private static readonly GOAL_PROGRESS_THROTTLE_MS = 1000;

  /**
   * Always-injected profile block: total char budget and per-entry slice.
   * Bounded by budget (not count) so the block can't balloon, with worth-
   * ranked selection so identity facts outlive over-tagged trivia.
   */
  private static readonly PROFILE_BLOCK_CHAR_BUDGET = 4000;
  private static readonly PROFILE_ENTRY_CHAR_CAP = 400;

  /** submit_job pipelines may legitimately run many bus calls; give them room. */
  private static readonly SUBMIT_JOB_TIMEOUT_MS = 300000;
  /** Cap on a job result entering the conversation; jobs should aggregate. */
  private static readonly SUBMIT_JOB_RESULT_CAP = 20000;

  /** Active task entry during LLM streaming -- links llmChunk events to the right ticket. */
  private activeStreamEntry?: TaskEntry;
  /** Throttle timestamp for streaming progress events (1/sec max). */
  private lastStreamProgressTs = 0;

  /**
   * Per-agent task queues. Each registered agent runs one task at a time
   * through its OTA loop; additional tasks queue up here and the queue
   * runner pops the next one when the current task finishes.
   *
   * The `inFlight` slot replaces the legacy `busyAgents` mutual-exclusion
   * mechanism. Cancellation: pending tasks splice out of `pending`;
   * in-flight tasks set `entry.state.phase = 'error'` with `error: 'Cancelled'`
   * which the OTA loop checks at observe/think boundaries.
   *
   * Filled by `enqueueTask` (called by ScrumMaster after each scrum plans
   * tasks) and drained by `runTaskAsync`'s tail when each task terminates.
   */
  private agentTaskQueues = new Map<AbjectId, {
    inFlight?: { taskId: string; goalId?: string };
    pending: QueuedTask[];
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
              name: 'getTaskTranscript',
              description: 'Fetch a finished task\'s full record for post-task review: the flattened LLM conversation, outcome, and which knowledge entries were injected at init. Only terminal (done/error) tasks have a stable transcript.',
              parameters: [
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'Task ID' },
              ],
              returns: { kind: 'object', properties: {
                taskId: { kind: 'primitive', primitive: 'string' },
                agentName: { kind: 'primitive', primitive: 'string' },
                task: { kind: 'primitive', primitive: 'string' },
                phase: { kind: 'primitive', primitive: 'string' },
                goalId: { kind: 'primitive', primitive: 'string' },
                transcript: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'releaseTask',
              description: 'Drop a terminal task\'s entry (transcript and state) after review, freeing memory. No-op for in-flight tasks.',
              parameters: [
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'Task ID' },
              ],
              returns: { kind: 'object', properties: { released: { kind: 'primitive', primitive: 'boolean' } } },
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
              description: 'Cancel a task. If in-flight, the OTA loop bails at the next observe/think boundary. If pending in some agent\'s queue, splice it out so it never starts.',
              parameters: [
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'Task ID' },
                { name: 'agentId', type: { kind: 'primitive', primitive: 'string' }, description: 'Optional hint — only scan this agent\'s queue', optional: true },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                where: { kind: 'primitive', primitive: 'string' },
              } },
            },
            {
              name: 'enqueueTask',
              description: 'Enqueue a task on a specific agent\'s task queue. The agent runs queued tasks one at a time through its OTA loop. Used by ScrumMaster to assign Sprint Backlog items.',
              parameters: [
                { name: 'agentId', type: { kind: 'primitive', primitive: 'string' }, description: 'Target agent — required' },
                { name: 'task', type: { kind: 'primitive', primitive: 'string' }, description: 'Task description' },
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'Caller-provided task ID (e.g. tuple ID for goal tasks)', optional: true },
                { name: 'systemPrompt', type: { kind: 'primitive', primitive: 'string' }, description: 'Override system prompt', optional: true },
                { name: 'initialMessages', type: { kind: 'array', elementType: { kind: 'object', properties: {} } }, description: 'Initial conversation messages', optional: true },
                { name: 'config', type: { kind: 'object', properties: {} }, description: 'Per-task config overrides', optional: true },
                { name: 'responseSchema', type: { kind: 'object', properties: {} }, description: 'JSON Schema for structured result', optional: true },
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal this task belongs to (for cancellation cascades and progress)', optional: true },
                { name: 'dispatchTupleId', type: { kind: 'primitive', primitive: 'string' }, description: 'TupleSpace tuple ID — when set, AgentAbject calls completeTask/failTask on this tuple after the OTA loop terminates', optional: true },
                { name: 'data', type: { kind: 'object', properties: {} }, description: 'Opaque task-specific data forwarded to the agent\'s executeTask `data` field (e.g. { target } naming a concrete object). AgentAbject does not interpret it.', optional: true },
              ],
              returns: { kind: 'object', properties: {
                taskId: { kind: 'primitive', primitive: 'string' },
                queuePosition: { kind: 'primitive', primitive: 'number' },
              } },
            },
            {
              name: 'listAgentQueue',
              description: 'Inspect an agent\'s task queue: returns { inFlight, pending }.',
              parameters: [
                { name: 'agentId', type: { kind: 'primitive', primitive: 'string' }, description: 'Agent ID' },
              ],
              returns: { kind: 'object', properties: {
                inFlight: { kind: 'object', properties: {} },
                pending: { kind: 'array', elementType: { kind: 'object', properties: {} } },
              } },
            },
            {
              name: 'drainAgentQueue',
              description: 'Drop all pending tasks from an agent\'s queue (without cancelling the in-flight task).',
              parameters: [
                { name: 'agentId', type: { kind: 'primitive', primitive: 'string' }, description: 'Agent ID' },
              ],
              returns: { kind: 'object', properties: { drained: { kind: 'primitive', primitive: 'number' } } },
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

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## AgentAbject Usage Guide

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
    goalId: 'existing-goal-id',  // optional — task runs without a goal if omitted
  });

Inside job code, goal helpers are available automatically:
- await updateGoal('Building UI...', 'phase-name')
- await getGoal()  // returns current Goal object
- await completeGoal(result)
- await failGoal('reason')

### Task Dispatch & Semantic Matching

Tasks are dispatched to agents via TupleSpace. Each agent is asked "how would you
accomplish this task?" and describes its approach. An evaluator picks the most
efficient approach. Write clear, descriptive agent descriptions to improve matching.

### Creating a User Agent (ScriptableAbject as Agent)

Any ScriptableAbject can register as an agent. In the startup/show handler, call registerAgent.
AgentAbject will then send executeTask, agentObserve, and agentAct messages to the object
when tasks are dispatched to it via the ask protocol.

  // Register as agent (in startup or show handler):
  await call(await dep('AgentAbject'), 'registerAgent', {
    name: 'MyAgent',
    description: 'Short description of what this agent handles',
    systemPrompt: 'You are an agent that specializes in...',
    config: {
      maxSteps: 15,
      timeout: 180000,
      terminalActions: {
        done: { type: 'success', resultFields: ['result'] },
        fail: { type: 'error', resultFields: ['reason'] },
      },
      intermediateActions: ['reply'],
    },
    canExecute: true,
  });
  // Returns: { agentId }

  // Unregister (in hide handler):
  await call(await dep('AgentAbject'), 'unregisterAgent', {});

The registered object must implement these handlers to participate in the agent loop:

  executeTask(msg) — Called when a task is dispatched to this agent from TupleSpace.
    msg.payload: { goalId, description, data }
    The handler should call startTask on AgentAbject to begin the observe-think-act loop.

  agentObserve(msg) — Called during the observe phase.
    msg.payload: { taskId }
    Return: { observation: string } describing the current state/context.

  agentAct(msg) — Called during the act phase with the LLM's chosen action.
    msg.payload: { taskId, action: { action, reasoning, ...params } }
    Return: { success: boolean, data?: any, error?: string }

  taskResult(msg) — Receives the final result when a task completes.
    msg.payload: { ticketId, success, result?, error?, steps }

### IMPORTANT
- startTask returns { ticketId } immediately — it does NOT block until completion.
- Results arrive asynchronously via a taskResult event sent to the caller.
- taskProgress events provide live step/phase updates during execution.
- taskStream events provide streaming LLM tokens during the think phase.
- Agents must be registered before tasks can be sent to them.
- listTasks includes goalId on each task entry for cross-referencing with GoalManager.
- getAgentState returns an agent's active tasks with their goalIds — use it to see what an agent is working on.`;
  }

  protected override async handleAsk(question: string): Promise<string> {
    let prompt = this.askPrompt(question);

    // Dynamically include the list of currently registered agents
    if (this.registeredAgents.size > 0) {
      prompt += '\n\n### Currently Registered Agents\n';
      for (const agent of this.registeredAgents.values()) {
        const activeTasks = this.countActiveTasks(agent.agentId);
        const status = activeTasks > 0 ? `busy (${activeTasks} tasks)` : 'idle';
        prompt += `- **${agent.name}** [${status}]: ${agent.description}\n`;
      }
    }

    return this.askLlm(prompt, question, 'balanced');
  }

  protected override async onInit(): Promise<void> {
    this.llmId = await this.discoverDep('LLM') ?? undefined;
    this.jobManagerId = await this.discoverDep('JobManager') ?? undefined;
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;
    this.tupleSpaceId = await this.discoverDep('TupleSpace') ?? undefined;
    // No TupleSpace watcher and no periodic scan: under the Scrum model,
    // ScrumMaster places tasks via enqueueTask. AgentAbject runs the OTA
    // loop for each queued task and pops the next one when the current
    // task terminates. There is nothing to scan for.
  }

  protected override async onStop(): Promise<void> {
    // Drain in-flight tasks to error so any awaiting callers get a clean
    // signal rather than hanging. Pending queues drop on the floor — they
    // weren't started so there's no partial work to surface.
    for (const [agentId, q] of this.agentTaskQueues) {
      if (q.inFlight) {
        const entry = this.taskEntries.get(q.inFlight.taskId);
        if (entry && entry.state.phase !== 'done' && entry.state.phase !== 'error') {
          entry.state.phase = 'error';
          entry.state.error = 'AgentAbject stopped';
        }
      }
      q.pending.length = 0;
      void agentId;
    }
    this.agentTaskQueues.clear();
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
      const { name, description, systemPrompt, config, canExecute } =
        msg.payload as { name: string; description: string; systemPrompt?: string; config?: AgentConfig; canExecute?: boolean };
      const agentId = msg.routing.from;
      const resolved = resolveConfig(config);

      this.registeredAgents.set(agentId, {
        agentId,
        name,
        description,
        systemPrompt,
        config: resolved,
        canExecute: canExecute ?? true,
        registeredAt: Date.now(),
      });

      log.info(`Agent registered: "${name}" (${agentId})`);
      this.changed('agentRegistered', { agentId, name });
      return { agentId };
    });

    this.on('unregisterAgent', async (msg: AbjectMessage) => {
      const agentId = msg.routing.from;
      const deleted = this.registeredAgents.delete(agentId);
      // Drop any queued tasks for this agent — they have nowhere to run now.
      // In-flight tasks remain in taskEntries for their last bit of cleanup
      // (the state machine will be torn down when its handlers stop responding).
      const q = this.agentTaskQueues.get(agentId);
      if (q) {
        if (q.pending.length > 0) {
          log.info(`Agent ${agentId} unregistered with ${q.pending.length} pending task(s); dropping`);
        }
        this.agentTaskQueues.delete(agentId);
      }
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
          canExecute: agent.canExecute,
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
        dispatchTupleId,
      } = msg.payload as {
        agentId?: AbjectId;
        taskId?: string;
        task: string;
        systemPrompt?: string;
        initialMessages?: { role: string; content: string | ContentPart[] }[];
        config?: Partial<AgentConfig>;
        responseSchema?: Record<string, unknown>;
        goalId?: string;
        dispatchTupleId?: string;
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

      // Use the provided goal if given. Goal creation is the responsibility
      // of the calling agent, not the runtime.
      const goalId = incomingGoalId;

      const entry: TaskEntry = {
        state: taskState,
        agentId,
        callerId,
        config,
        systemPrompt: prompt,
        initialMessages,
        responseSchema,
        goalId,
        dispatchTupleId,
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

    /**
     * Enqueue a task on an agent's task queue. Used by ScrumMaster (or any
     * caller that wants explicit per-agent serialization) to hand work to a
     * specific agent. The agent's OTA loop runs queued tasks one at a time;
     * ScrumMaster receives a `taskResult` event when each task terminates.
     *
     * Returns `{ taskId, queuePosition }` where queuePosition is 0 if the
     * task started immediately (queue was idle), or N if it queued behind
     * N other pending tasks.
     */
    this.on('enqueueTask', async (msg: AbjectMessage) => {
      const {
        agentId: targetAgentId,
        task,
        taskId: callerTaskId,
        systemPrompt,
        initialMessages,
        config: taskConfig,
        responseSchema,
        goalId,
        dispatchTupleId,
        callerId: explicitCaller,
        data,
      } = msg.payload as {
        agentId: AbjectId;
        task: string;
        taskId?: string;
        systemPrompt?: string;
        initialMessages?: { role: string; content: string | ContentPart[] }[];
        config?: Partial<AgentConfig>;
        responseSchema?: Record<string, unknown>;
        goalId?: string;
        dispatchTupleId?: string;
        callerId?: AbjectId;
        data?: Record<string, unknown>;
      };
      if (!targetAgentId) throw new Error('enqueueTask requires agentId');
      const agent = this.registeredAgents.get(targetAgentId);
      if (!agent) throw new Error(`Agent "${targetAgentId}" is not registered`);

      const taskId = callerTaskId ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const callerId = explicitCaller ?? msg.routing.from;

      let q = this.agentTaskQueues.get(targetAgentId);
      if (!q) {
        q = { pending: [] };
        this.agentTaskQueues.set(targetAgentId, q);
      }
      const queued: QueuedTask = {
        taskId,
        task,
        systemPrompt,
        initialMessages,
        config: taskConfig,
        responseSchema,
        goalId,
        dispatchTupleId,
        callerId,
        enqueuedAt: Date.now(),
        data,
      };
      q.pending.push(queued);
      const queuePosition = q.pending.length - 1 + (q.inFlight ? 1 : 0);
      log.info(`enqueueTask: agent=${agent.name} task="${task.slice(0, 60)}" position=${queuePosition} (inFlight=${q.inFlight ? 'yes' : 'no'})`);
      // Kick the queue runner — no-op if inFlight is already set.
      this.processNextInQueue(targetAgentId);
      return { taskId, queuePosition };
    });

    /**
     * Inspect an agent's queue. Returns `{ inFlight, pending }` where
     * inFlight is the currently-running task (or undefined) and pending is
     * the FIFO list of tasks waiting their turn.
     */
    this.on('listAgentQueue', async (msg: AbjectMessage) => {
      const { agentId } = msg.payload as { agentId: AbjectId };
      const q = this.agentTaskQueues.get(agentId);
      if (!q) return { inFlight: null, pending: [] };
      const summarise = (t: QueuedTask) => ({
        taskId: t.taskId,
        task: t.task.slice(0, 100),
        goalId: t.goalId ?? null,
        enqueuedAt: t.enqueuedAt,
      });
      return {
        inFlight: q.inFlight ? { taskId: q.inFlight.taskId, goalId: q.inFlight.goalId ?? null } : null,
        pending: q.pending.map(summarise),
      };
    });

    /**
     * Drain pending tasks from an agent's queue without cancelling the
     * in-flight task. Used by ScrumMaster on cleanup paths where we want
     * to abandon scheduled work but let the current task run to completion.
     */
    this.on('drainAgentQueue', async (msg: AbjectMessage) => {
      const { agentId } = msg.payload as { agentId: AbjectId };
      const q = this.agentTaskQueues.get(agentId);
      if (!q) return { drained: 0 };
      const drained = q.pending.length;
      q.pending = [];
      log.info(`drainAgentQueue: agent ${agentId.slice(0, 8)} drained ${drained} pending task(s)`);
      return { drained };
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

    // ── Post-task review support ──
    this.on('getTaskTranscript', async (msg: AbjectMessage) => {
      const { taskId } = msg.payload as { taskId: string };
      const entry = this.taskEntries.get(taskId);
      // A terminal phase alone is not enough: a cancelled task's machine may
      // still be running (phase flipped mid-await). Only finished entries
      // have a stable transcript.
      if (!entry || !entry.finished) return null;
      return {
        taskId: entry.state.id,
        agentId: entry.agentId,
        agentName: this.registeredAgents.get(entry.agentId)?.name ?? 'unknown',
        task: entry.state.task,
        phase: entry.state.phase,
        steps: entry.state.step,
        result: entry.state.result,
        error: entry.state.error,
        goalId: entry.goalId ?? entry.incomingGoalId ?? null,
        injectedKnowledge: entry.injectedKnowledge ?? [],
        transcript: flattenTranscript(entry.state.llmMessages),
      };
    });

    this.on('releaseTask', async (msg: AbjectMessage) => {
      const { taskId } = msg.payload as { taskId: string };
      const entry = this.taskEntries.get(taskId);
      if (!entry) return { released: false };
      if (!entry.finished || (entry.state.phase !== 'done' && entry.state.phase !== 'error')) {
        return { released: false };
      }
      this.taskEntries.delete(taskId);
      const idx = this.taskOrder.indexOf(taskId);
      if (idx >= 0) this.taskOrder.splice(idx, 1);
      return { released: true };
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

    /**
     * Cancel a task. If it's currently in-flight (has a TaskEntry and isn't
     * already terminal), set its phase to error so the OTA loop bails at the
     * next observe/think boundary. If it's pending in some agent's queue,
     * splice it out so it never starts. `agentId` is optional; when omitted
     * we scan every queue's pending list for a match.
     */
    this.on('cancelTask', async (msg: AbjectMessage) => {
      const { taskId, agentId: hintedAgent } = msg.payload as { taskId: string; agentId?: AbjectId };
      // First check in-flight tasks
      const entry = this.taskEntries.get(taskId);
      if (entry && entry.state.phase !== 'done' && entry.state.phase !== 'error') {
        entry.state.phase = 'error';
        entry.state.error = 'Cancelled';
        return { success: true, where: 'in-flight' };
      }
      // Then check queue pending lists
      const queuesToScan = hintedAgent
        ? [this.agentTaskQueues.get(hintedAgent)].filter((q): q is NonNullable<typeof q> => !!q)
        : [...this.agentTaskQueues.values()];
      for (const q of queuesToScan) {
        const idx = q.pending.findIndex(t => t.taskId === taskId);
        if (idx >= 0) {
          q.pending.splice(idx, 1);
          return { success: true, where: 'queue' };
        }
      }
      return { success: false };
    });

    this.on('cancelTasksByGoal', async (msg: AbjectMessage) => {
      const { goalId } = msg.payload as { goalId: string };
      let cancelled = 0;
      // Cancel in-flight tasks (set phase=error so the OTA loop bails at the
      // next observe/think boundary; runTaskAsync's tail will pop the next
      // queued task as usual).
      for (const [taskId, entry] of this.taskEntries) {
        if ((entry.goalId === goalId || entry.incomingGoalId === goalId)
            && entry.state.phase !== 'done' && entry.state.phase !== 'error') {
          entry.state.phase = 'error';
          entry.state.error = 'Cancelled';
          cancelled++;
          log.info(`cancelTasksByGoal: cancelled in-flight task ${taskId} for goal ${goalId}`);
        }
      }
      // Drain pending tasks for this goal from every agent's queue.
      for (const [agentId, q] of this.agentTaskQueues) {
        const before = q.pending.length;
        q.pending = q.pending.filter(t => t.goalId !== goalId);
        const dropped = before - q.pending.length;
        if (dropped > 0) {
          log.info(`cancelTasksByGoal: dropped ${dropped} pending task(s) from agent ${agentId.slice(0, 8)} for goal ${goalId}`);
          cancelled += dropped;
        }
      }
      return { cancelled };
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

      // Streaming chunks prove the LLM is alive. Emit a self-directed
      // progress event so the base-class handler resets ALL pending request
      // timers (including the 120s stream request timer) and bubbles the
      // signal upstream through the call tree. Throttled to 1/sec so we
      // don't flood the bus on fast streams.
      const now = Date.now();
      if (now - this.lastStreamProgressTs > 1000) {
        this.lastStreamProgressTs = now;
        this.send(event(this.id, this.id, 'progress', {
          phase: 'streaming',
          message: `streaming (${content.length} chars)`,
        }));
        // Also notify the registered agent (callerId) so its inactivity
        // timer resets during long LLM calls. The self-directed progress
        // above only bubbles via _handlingRequestSenders (JobManager), which
        // doesn't reach the agent that started the task.
        if (entry.callerId !== this.id) {
          this.send(event(this.id, entry.callerId, 'progress', {
            phase: 'streaming',
            message: 'LLM thinking...',
          }));
        }
      }
    });

    // Note: progress events are handled by Abject base class which auto-bubbles
    // them upstream and resets all pending request timeouts.

    // ── JobManager failure notification ──
    // When a job we submitted fails, JobManager sends us a direct jobFailed
    // event carrying the submitJob request's message id. Reject exactly that
    // pending request so the step unblocks immediately. Rejecting every
    // pending JobManager request here (the old behavior) took down other
    // agents' unrelated in-flight phase jobs: one agent's failed submit_job
    // pipeline surfaced its error inside a different agent's task.
    this.on('jobFailed', async (msg: AbjectMessage) => {
      const { jobId, error, requestMessageId } = msg.payload as {
        jobId: string; error?: string; requestMessageId?: string;
      };
      const err = new Error(error ?? `Job ${jobId} failed`);
      if (requestMessageId) {
        if (this.rejectPendingRequest(requestMessageId, err)) {
          log.info(`[${this.manifest.name}] jobFailed ${jobId} — rejected its pending request`);
        }
        return;
      }
      // Compatibility fallback for jobFailed events without a request id.
      const rejected = this.rejectPendingRequestsTo(msg.routing.from, err);
      if (rejected > 0) {
        log.info(`[${this.manifest.name}] jobFailed ${jobId} — rejected ${rejected} pending request(s)`);
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
  private async observeStep(entry: TaskEntry): Promise<{ observation: string; llmContent?: ContentPart[]; tier?: string }> {
    return this.request<{ observation: string; llmContent?: ContentPart[]; tier?: string }>(
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

    // Also emit a 'progress' event to ourselves so the base-class progress handler
    // resets all our pending request timers (most importantly the submitJob to
    // JobManager) and bubbles upstream to whoever called us.
    this.send(event(this.id, this.id, 'progress', {
      ticketId: entry.state.id,
      step: entry.state.step,
      phase: newPhase,
    }));

    // Update goal progress via GoalManager. Prefer the action's reasoning —
    // the same rich text JobManager shows as the job description — over the
    // bare verb, so the goal tree reads "Sanitize the control characters in
    // the report field" instead of "shell...".
    if (entry.goalId && this.goalManagerId) {
      const agentName = this.registeredAgents.get(entry.agentId)?.name ?? 'Agent';
      const reasoning = typeof entry.state.action?.reasoning === 'string'
        ? entry.state.action.reasoning.trim()
        : '';
      const msg = newPhase === 'acting' && entry.state.action?.action
        ? (reasoning ? reasoning.slice(0, 140) : `${entry.state.action.action}...`)
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

    // Solo agent run with goalId set but no dispatchTupleId: the caller owns
    // the goal end-to-end, so completeGoal/failGoal is correct here. Tasks
    // queued via enqueueTask carry dispatchTupleId; ScrumMaster owns goal
    // lifecycle for those, so we don't compete with it.
    if (entry.goalId && this.goalManagerId && !entry.dispatchTupleId) {
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

    // For tasks dispatched via enqueueTask (dispatchTupleId set), AgentAbject
    // calls completeTask / failTask on the originating tuple so ScrumMaster's
    // goalReadyForCompletion trigger fires. The taskResult event below also
    // carries the same outcome to the caller (typically ScrumMaster).
    if (entry.dispatchTupleId && this.goalManagerId) {
      const agentName = this.registeredAgents.get(entry.agentId)?.name ?? 'Unknown';
      try {
        if (success) {
          await this.request(request(this.id, this.goalManagerId, 'completeTask', {
            taskId: entry.dispatchTupleId,
            goalId: entry.incomingGoalId ?? entry.goalId,
            result: entry.state.result,
          }));
          log.info(`[${agentName}] Task ${entry.state.id.slice(0, 8)} done; tuple ${entry.dispatchTupleId.slice(0, 8)} marked done`);
        } else {
          await this.request(request(this.id, this.goalManagerId, 'failTask', {
            taskId: entry.dispatchTupleId,
            goalId: entry.incomingGoalId ?? entry.goalId,
            error: entry.state.error ?? 'Task failed',
            agentName,
            agentId: entry.agentId,
          }));
          log.info(`[${agentName}] Task ${entry.state.id.slice(0, 8)} failed; tuple ${entry.dispatchTupleId.slice(0, 8)} marked failed`);
        }
      } catch (err) {
        log.warn(`completeTask/failTask for tuple ${entry.dispatchTupleId.slice(0, 8)} failed: ${err instanceof Error ? err.message : String(err)}`);
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

    entry.finished = true;
    this.changed('taskCompleted', {
      taskId: entry.state.id,
      agentId: entry.agentId,
      agentName: this.registeredAgents.get(entry.agentId)?.name ?? 'unknown',
      goalId: entry.goalId ?? entry.incomingGoalId ?? null,
      steps: entry.state.step,
      success,
      result: success ? entry.state.result : undefined,
      error: success ? undefined : entry.state.error,
    });

    // Bound the task graveyard: keep only the most recent terminal entries so
    // long-lived workspaces stop accumulating dead transcripts. The reviewer
    // releases entries earlier via releaseTask; this is the backstop when no
    // reviewer is running. In-flight entries are never pruned.
    this.pruneTerminalEntries();

    // ── Queue runner ──
    // Clear inFlight for this agent and pop the next pending task, if any.
    // The queue's inFlight slot is the one-task-at-a-time guard that
    // replaces the legacy `busyAgents` set.
    const q = this.agentTaskQueues.get(entry.agentId);
    if (q && q.inFlight?.taskId === entry.state.id) {
      q.inFlight = undefined;
      this.processNextInQueue(entry.agentId);
    }
  }

  /**
   * Pop the next pending task from an agent's queue and start it through
   * the OTA loop. No-op if `inFlight` is set or `pending` is empty.
   * Called from `enqueueTask` (initial kick-off) and from `runTaskAsync`'s
   * tail (when a task terminates and the slot frees).
   */
  private processNextInQueue(agentId: AbjectId): void {
    const q = this.agentTaskQueues.get(agentId);
    if (!q || q.inFlight || q.pending.length === 0) return;
    const next = q.pending.shift()!;
    q.inFlight = { taskId: next.taskId, goalId: next.goalId };
    this.startQueuedTask(agentId, next).catch(err => {
      log.warn(`startQueuedTask for ${agentId.slice(0, 8)} threw: ${err instanceof Error ? err.message : String(err)}`);
      // Free the slot so subsequent enqueues aren't stuck.
      const q2 = this.agentTaskQueues.get(agentId);
      if (q2) q2.inFlight = undefined;
      this.processNextInQueue(agentId);
    });
  }

  /**
   * Send the queued task to the agent's `executeTask` handler so the agent
   * can do its per-task setup (e.g. ObjectCreator's LoopState) and then call
   * back into AgentAbject.startTask. The queued taskId flows through to the
   * agent's startTask so AgentAbject's TaskEntry, the agent's per-task state,
   * and the queue's `inFlight` slot all share one ID — runTaskAsync's tail
   * matches `entry.state.id` against `q.inFlight.taskId` to clear the slot
   * and pop the next pending task.
   */
  private async startQueuedTask(agentId: AbjectId, queued: QueuedTask): Promise<void> {
    const agent = this.registeredAgents.get(agentId);
    if (!agent) {
      log.warn(`startQueuedTask: agent ${agentId.slice(0, 8)} no longer registered; dropping task ${queued.taskId.slice(0, 8)}`);
      const q = this.agentTaskQueues.get(agentId);
      if (q) {
        q.inFlight = undefined;
        this.processNextInQueue(agentId);
      }
      return;
    }
    log.info(`Queue runner: starting task ${queued.taskId.slice(0, 8)} on agent ${agent.name}`);
    // Fire-and-forget. The agent's executeTask handler returns DEFERRED_REPLY;
    // we don't await its response. AgentAbject's runTaskAsync runs the state
    // machine synchronously (within the async event loop) and its tail clears
    // the queue's inFlight slot.
    this.send(request(this.id, agentId, 'executeTask', {
      tupleId: queued.taskId,
      taskId: queued.taskId,
      goalId: queued.goalId,
      description: queued.task,
      callerId: queued.callerId,
      systemPrompt: queued.systemPrompt,
      initialMessages: queued.initialMessages,
      config: queued.config,
      responseSchema: queued.responseSchema,
      dispatchTupleId: queued.dispatchTupleId ?? queued.taskId,
      data: queued.data,
    }));
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
            const obsData = obsResult.data as { observation: string; llmContent?: ContentPart[]; tier?: string };
            task.observation = obsData.observation;
            if (obsData.llmContent) entry.lastObservationLlmContent = obsData.llmContent;
            else entry.lastObservationLlmContent = undefined;
            if (obsData.tier) entry.observeTier = obsData.tier;


            setPhase('thinking');
            break;
          }

          case 'thinking': {
            // ── Batch drain ──
            // A multi-action LLM response queued actions 2..N; execute them
            // in order without an LLM round-trip between them. A mid-batch
            // failure discards the rest so the model reassesses with the
            // real results in front of it.
            if (entry.pendingActions?.length) {
              if (task.lastResult && !task.lastResult.success) {
                task.llmMessages.push({
                  role: 'user',
                  content: `[Batch] Discarded ${entry.pendingActions.length} remaining batched action(s) because the action before them failed (see the failure result below). Reassess before re-emitting them.`,
                });
                entry.pendingActions = undefined;
                // fall through to the normal LLM think
              } else {
                // Record the finished action's result now — the next drained
                // action overwrites lastResult before any think() runs.
                this.addActionResultToConversation(entry);
                task.lastResult = undefined;
                task.action = entry.pendingActions.shift();
                log.info(`[${agentName}] Step ${task.step + 1} — draining batched action: ${task.action?.action} (${entry.pendingActions.length} left)`);
                // Terminals, replan, remember, recall, submit_job, and ask_user were filtered out
                // at parse time, so only intermediate and plain actions reach
                // this point.
                if (task.action && this.isIntermediateAction(entry, task.action)) {
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
            }

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

            // ── Reparse sentinels from parseAction ──
            // _reparse: unparseable LLM output, correction message already pushed — loop back into thinking.
            // _reparse_abort: retries exhausted and no error terminal configured — fail hard.
            if (task.action.action === '_reparse') {
              task.step++;
              if (task.step >= task.maxSteps) {
                await this.handleMaxStepsReached(entry, agentName, setPhase);
                break;
              }
              setPhase('thinking');
              break;
            }
            if (task.action.action === '_reparse_abort') {
              setPhase('error');
              break;
            }

            // ── Replan: inject reason and continue thinking ──
            // Replan tells the LLM to try a different approach for the SAME
            // task. Decomposition is no longer an agent-level concern under
            // the Scrum model — ScrumMaster splits work across scrums.
            if (task.action.action === 'replan') {
              const reason = (task.action.reason as string) ?? 'Agent requested replan';
              log.info(`[${agentName}] Replan requested: ${reason.slice(0, 80)}`);

              let reflection = `[Replan] Reason: ${reason}\n`;
              if (entry.goalId && this.goalManagerId) {
                try {
                  reflection += await this.buildGoalProgressContext(entry.goalId);
                } catch { /* best effort */ }
              }
              reflection += '\nRe-evaluate and pick a different action that addresses what went wrong. If the task is genuinely outside your capability, emit a `fail` action with a clear reason.';

              task.llmMessages.push({ role: 'user', content: reflection });
              // Consume the pending observation/result so the next think()
              // doesn't re-append them (and the batch-drain guard doesn't
              // read a stale failure).
              task.observation = undefined;
              task.lastResult = undefined;
              task.step++;
              if (task.step >= task.maxSteps) {
                await this.handleMaxStepsReached(entry, agentName, setPhase);
                break;
              }
              setPhase('thinking');
              break;
            }

            // ── Remember: save to KnowledgeBase directly, continue thinking ──
            if (task.action.action === 'remember') {
              try {
                const kbId = await this.discoverDep('KnowledgeBase');
                if (kbId) {
                  await this.request(
                    request(this.id, kbId, 'remember', {
                      title: (task.action.title as string) ?? (task.action.description as string) ?? 'Untitled',
                      content: (task.action.content as string) ?? (task.action.description as string) ?? '',
                      type: (task.action.type as string) ?? 'fact',
                      tags: (task.action.tags as string[]) ?? [],
                    }),
                    10000,
                  );
                  log.info(`[${agentName}] Remembered: "${task.action.title ?? task.action.description}"`);
                  task.llmMessages.push({
                    role: 'user',
                    content: '[Remember] Saved successfully. Continue with the task.',
                  });
                } else {
                  task.llmMessages.push({ role: 'user', content: '[Remember] KnowledgeBase not available.' });
                }
              } catch (err) {
                task.llmMessages.push({
                  role: 'user',
                  content: `[Remember Error] ${err instanceof Error ? err.message : String(err)}`,
                });
              }
              // Consume the pending observation/result so the next think()
              // doesn't re-append them.
              task.observation = undefined;
              task.lastResult = undefined;
              task.step++;
              if (task.step >= task.maxSteps) {
                await this.handleMaxStepsReached(entry, agentName, setPhase);
                break;
              }
              break; // re-enter thinking
            }

            // ── recall: read from KnowledgeBase, continue thinking. The
            // write-side `remember` has been a runtime verb all along;
            // without a matching read verb, agents with fixed vocabularies
            // were told about the KB's lookup modes but had no action that
            // could reach them.
            if (task.action.action === 'recall') {
              try {
                const kbId = await this.discoverDep('KnowledgeBase');
                if (kbId) {
                  const id = task.action.id as string | undefined;
                  const pattern = task.action.pattern as string | undefined;
                  const query = task.action.query as string | undefined;
                  const tags = task.action.tags as string[] | undefined;
                  const limit = Math.min(typeof task.action.limit === 'number' ? task.action.limit : 5, 10);

                  let rendered: string;
                  if (id) {
                    const e = await this.request<{ title?: string; type?: string; content?: string } | null>(
                      request(this.id, kbId, 'get', { id }), 10000);
                    rendered = e
                      ? `**${e.title}** (${e.type}): ${(e.content ?? '').slice(0, 4000)}`
                      : `No entry with id "${id}".`;
                  } else if (pattern) {
                    const hits = await this.request<Array<{ id: string; title: string; type: string; content: string }>>(
                      request(this.id, kbId, 'match', { pattern, limit }), 10000);
                    rendered = hits.length > 0
                      ? hits.map(h => `- ${h.id} [${h.type}] ${h.title}: ${h.content.slice(0, 300)}`).join('\n')
                      : `No entries match pattern "${pattern}".`;
                  } else if (query || tags?.length) {
                    const hits = await this.request<Array<{ id: string; title: string; type: string; snippet?: string }>>(
                      request(this.id, kbId, 'recall', { query, tags, limit, previews: true }), 10000);
                    rendered = hits.length > 0
                      ? hits.map(h => `- ${h.id} [${h.type}] ${h.title}: ${h.snippet ?? ''}`).join('\n')
                      : 'No matching entries. Try different terms, or a `pattern` for exact names.';
                  } else {
                    rendered = 'recall needs one of: query (keywords), pattern (exact/regex), id (full entry), or tags.';
                  }
                  task.llmMessages.push({ role: 'user', content: `[Recall] ${rendered}` });
                } else {
                  task.llmMessages.push({ role: 'user', content: '[Recall] KnowledgeBase not available.' });
                }
              } catch (err) {
                task.llmMessages.push({
                  role: 'user',
                  content: `[Recall Error] ${err instanceof Error ? err.message : String(err)}`,
                });
              }
              task.observation = undefined;
              task.lastResult = undefined;
              task.step++;
              if (task.step >= task.maxSteps) {
                await this.handleMaxStepsReached(entry, agentName, setPhase);
                break;
              }
              break; // re-enter thinking
            }

            // ── submit_job: run a mechanical pipeline through JobManager,
            // continue thinking with the result. A runtime-level verb (like
            // `remember`): every agent has it without implementing anything,
            // and it is pure message passing — one submitJob request whose
            // sandboxed code interacts with the world only via call/dep/find
            // bus messages. This is how a 30-call chain costs one think step.
            if (task.action.action === 'submit_job') {
              const code = task.action.code as string | undefined;
              const description = (task.action.description as string) ?? 'agent pipeline';
              if (!code || code.trim().length === 0) {
                task.llmMessages.push({
                  role: 'user',
                  content: '[Job Error] submit_job requires a non-empty "code" field containing the JavaScript to run.',
                });
              } else {
                try {
                  const jmId = this.jobManagerId ?? await this.discoverDep('JobManager') ?? undefined;
                  if (jmId) {
                    // submit_job runs inside the thinking phase, so without
                    // this the goal tree shows "thinking" for the whole
                    // (possibly minutes-long) pipeline. Surface the job's
                    // own description instead.
                    if (entry.goalId && this.goalManagerId) {
                      this.send(event(this.id, this.goalManagerId, 'updateProgress', {
                        goalId: entry.goalId,
                        message: description.slice(0, 140),
                        phase: 'acting',
                        agentName,
                      }));
                    }
                    // submitJob replies with a JobResult envelope even for
                    // failed jobs; unwrap it so the conversation carries the
                    // job's actual return value, not the envelope.
                    const jobReply = await this.request<{ status?: string; result?: unknown; error?: string }>(
                      request(this.id, jmId, 'submitJob', {
                        description,
                        code,
                        // Dedicated queue per agent: pipeline jobs never
                        // interleave with the OTA loop's own phase jobs.
                        queue: `pipeline-${entry.agentId.slice(0, 8)}`,
                      }),
                      AgentAbject.SUBMIT_JOB_TIMEOUT_MS,
                    );
                    if (jobReply?.status === 'failed') {
                      log.info(`[${agentName}] submit_job "${description.slice(0, 60)}" failed: ${jobReply.error}`);
                      task.llmMessages.push({ role: 'user', content: `[Job Error] ${jobReply.error ?? 'job failed'}` });
                    } else {
                      const value = jobReply?.result;
                      let rendered = value === undefined || value === null
                        ? '(no result — return a value from the job code)'
                        : typeof value === 'string' ? value : JSON.stringify(value);
                      if (rendered.length > AgentAbject.SUBMIT_JOB_RESULT_CAP) {
                        rendered = rendered.slice(0, AgentAbject.SUBMIT_JOB_RESULT_CAP)
                          + `\n[... job result truncated at ${AgentAbject.SUBMIT_JOB_RESULT_CAP} chars — aggregate inside the job next time ...]`;
                      }
                      log.info(`[${agentName}] submit_job "${description.slice(0, 60)}" completed (${rendered.length} chars)`);
                      task.llmMessages.push({ role: 'user', content: `[Job Result] ${rendered}` });
                    }
                  } else {
                    task.llmMessages.push({ role: 'user', content: '[Job Error] JobManager not available.' });
                  }
                } catch (err) {
                  task.llmMessages.push({
                    role: 'user',
                    content: `[Job Error] ${err instanceof Error ? err.message : String(err)}`,
                  });
                }
              }
              // Consume the pending observation/result: submit_job chains
              // re-enter thinking repeatedly, and without this each round
              // re-appends the same observation and the previous action's
              // stale result (and a stale failure would falsely trigger the
              // batch-discard guard).
              task.observation = undefined;
              task.lastResult = undefined;
              task.step++;
              if (task.step >= task.maxSteps) {
                await this.handleMaxStepsReached(entry, agentName, setPhase);
                break;
              }
              break; // re-enter thinking
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

            // Loop detection: if the same action keeps producing the same result,
            // repeating it won't help. Steer the LLM toward a different approach
            // (or a clean `fail`) once per repeated pattern, so a misdiagnosis
            // can't burn the whole step budget oscillating.
            this.detectAndSteerOscillation(entry, agentName);

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
  // Loop / oscillation detection
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Build a stable signature for the just-executed action + its outcome.
   * Generic across every agent type: reads the common recipient/method-ish
   * fields defensively and normalizes the error so transient ids/numbers
   * (timeouts, UUIDs) don't make every repeat look unique.
   */
  private actionSignature(task: AgentTaskState): string {
    const a = (task.action ?? {}) as Record<string, unknown>;
    const name = String(a.action ?? 'unknown');
    const target = String(a.target ?? a.targetName ?? a.objectId ?? a.assignedAgentName ?? '');
    const method = String(a.method ?? a.kind ?? '');
    // Subject distinguishes actions that operate on a named member/slice (e.g.
    // read_draft / replace_handler / add_handler) so editing several different
    // handlers in a row isn't mistaken for repeating one — a real loop repeats
    // the SAME subject and still collapses to one signature.
    const subject = String(a.handler ?? a.name ?? a.lineRange ?? a.grep ?? a.key ?? '');
    let outcome: string;
    if (task.lastResult?.success) {
      outcome = 'ok';
    } else {
      outcome = String(task.lastResult?.error ?? 'err')
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
        .replace(/\d+/g, '<n>')
        .slice(0, 80);
    }
    return `${name}:${target}:${method}:${subject}:${outcome}`;
  }

  /**
   * Record the action signature and, when the same action keeps producing the
   * same result, inject a one-time steering message nudging the agent to change
   * strategy or fail cleanly. Fires once per distinct repeated pattern.
   */
  private detectAndSteerOscillation(entry: TaskEntry, agentName: string): void {
    const task = entry.state;
    if (!task.action) return;
    const sig = this.actionSignature(task);
    const history = (task.actionHistory ??= []);
    history.push(sig);
    // Keep the window bounded — only recent behaviour matters for "stuck".
    if (history.length > 12) history.shift();

    const occurrences = history.filter(s => s === sig).length;
    const failing = !task.lastResult?.success;
    // 3rd identical failure, or 4th identical attempt regardless of outcome
    // (re-doing the same successful step over and over is also a loop).
    const stuck = (failing && occurrences >= 3) || occurrences >= 4;
    if (!stuck) return;

    const nudged = (task.nudgedSignatures ??= []);
    if (nudged.includes(sig)) return;
    nudged.push(sig);

    log.info(`[${agentName}] Loop detected — same action repeated ${occurrences}x (${sig.slice(0, 60)}); steering`);
    task.llmMessages.push({
      role: 'user',
      content:
        `[Loop detected] You have repeated the same action with the same result ${occurrences} times ` +
        `(action: ${String((task.action as Record<string, unknown>).action)}). Repeating it again will produce the same outcome. ` +
        `Step back and change approach: re-read the latest error, and ask/describe the dependency it involves to learn the correct usage before retrying. ` +
        `Fix the root cause the error names rather than re-attempting the identical step. ` +
        `If the task is genuinely blocked, emit a \`fail\` action with a precise diagnosis: what is blocking you, what you tried, and what would unblock it.`,
    });
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

    // The budget is spent — any still-queued batched actions must not drain,
    // and the forced-final parse below must not enqueue new ones.
    entry.pendingActions = undefined;

    // Try one final LLM call to synthesize accumulated data
    try {
      task.llmMessages.push({
        role: 'user',
        content: `[BUDGET EXHAUSTED — Final Step]\nYou have used all ${task.maxSteps} steps. You MUST respond with a "done" or "fail" action NOW.\nIf you have extracted ANY useful data during this task, respond with:\n\`\`\`json\n{"action": "done", "result": <your best result so far>}\n\`\`\`\nOtherwise respond with:\n\`\`\`json\n{"action": "fail", "reason": "Could not complete task in ${task.maxSteps} steps"}\n\`\`\``,
      });

      const finalRoute = await this.applyVisionTiering(entry, 'smart');
      await this.trimConversation(entry);

      this.llmId = await this.resolveDep('LLM', this.llmId);
      const llmResult = await this.request<{ content: string }>(
        request(this.id, this.llmId, 'complete', {
          messages: task.llmMessages,
          // Thinking / action decisions run on 'smart' regardless of the observe
          // hint (fast-tier models drop the JSON action envelope under load,
          // producing prose that the parser can't accept), adjusted for vision
          // when the conversation carries images.
          ...(finalRoute.provider ? { provider: finalRoute.provider } : {}),
          options: {
            tier: finalRoute.tier,
            ...(finalRoute.model ? { model: finalRoute.model } : {}),
            maxTokens: 16384,
            cacheKey: entry.state.id,
          },
        }),
        60000,
      );

      task.llmMessages.push({ role: 'assistant', content: llmResult.content });

      const parsed = this.parseAction(entry, llmResult.content);
      entry.pendingActions = undefined; // only a terminal matters here
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
      // The OTA loop's job code is a fixed dispatch wrapper (call → agentObserve
      // / _think / agentAct); it uses only `call`. Agents act through structured
      // JSON actions handled in TS, and reach the goal/scratchpad by messaging
      // GoalManager — they never author code that runs in this job scope. A goal
      // helper preamble used to be prepended here, but nothing referenced it, so
      // it has been removed. Goal access is documented in the system prompt as
      // GoalManager methods reached via the agent's normal actions.
      const fullCode = code;

      const jobMgrId = await this.resolveDep('JobManager', this.jobManagerId);
      const submitMsg = request(this.id, jobMgrId, 'submitJob', {
        description,
        code: fullCode,
        ...(entry.config.queueName ? { queue: entry.config.queueName } : {}),
      });
      const jobResult = await this.request<JobResult>(submitMsg, entry.state.timeout);
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

  /**
   * Resolve the model tier for the thinking (JSON-action-decision) step from
   * the agent's last observe hint. The decision step never drops to 'fast':
   * haiku unreliably emits the action envelope under load, so the floor is
   * 'balanced'. An agent opts a routine state down to 'balanced' by returning
   * tier:'balanced' (or 'fast') from agentObserve; any other hint — including
   * none — keeps the default 'smart'. This is how per-state tiering reaches the
   * OTA loop: cheap mechanical/verification steps run on balanced, hard ones
   * (drafting code, diagnosing errors, planning) stay on smart.
   */
  private resolveThinkTier(hint?: string): 'smart' | 'balanced' {
    return (hint === 'balanced' || hint === 'fast') ? 'balanced' : 'smart';
  }

  // ── Vision-aware tiering ─────────────────────────────────────────────

  /** Cached per-tier capabilities from the LLM service. */
  private tierCapsCache?: { caps: TierCapabilities; at: number };
  private static readonly TIER_CAPS_TTL_MS = 60_000;

  /**
   * Per-tier model capabilities from the LLM service, cached briefly so the
   * OTA loop doesn't add a bus round-trip to every step. Returns undefined
   * when the LLM service can't answer (agents then keep current behavior).
   */
  protected async tierCapabilities(): Promise<TierCapabilities | undefined> {
    const now = Date.now();
    if (this.tierCapsCache && now - this.tierCapsCache.at < AgentAbject.TIER_CAPS_TTL_MS) {
      return this.tierCapsCache.caps;
    }
    try {
      this.llmId = await this.resolveDep('LLM', this.llmId);
      const caps = await this.request<TierCapabilities>(
        request(this.id, this.llmId!, 'describeTiers', {})
      );
      this.tierCapsCache = { caps, at: now };
      return caps;
    } catch {
      return this.tierCapsCache?.caps;
    }
  }

  private static conversationHasImages(messages: { role: string; content: string | ContentPart[] }[]): boolean {
    return messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image'));
  }

  /** Replace image parts with a text note in place; returns how many were replaced. */
  private static stripImageParts(messages: { role: string; content: string | ContentPart[] }[]): number {
    let replaced = 0;
    for (const m of messages) {
      if (typeof m.content === 'string') continue;
      m.content = m.content.map(part => {
        if (part.type !== 'image') return part;
        replaced++;
        return {
          type: 'text',
          text: '[Image omitted: the model configured for this step is text-only. Work from the text context; mention to the user that the current model cannot see images if the image was essential.]',
        } as ContentPart;
      });
    }
    return replaced;
  }

  /**
   * How to route a think step given what the conversation actually carries.
   * `tier` always rides along (it also sets the provider's effort/token
   * defaults); `provider`+`model` are set only when the step must run on the
   * configured vision-fallback model instead of the tier's own model.
   */
  private async applyVisionTiering(
    entry: TaskEntry,
    tier: 'smart' | 'balanced',
  ): Promise<{ tier: 'smart' | 'balanced'; provider?: string; model?: string }> {
    const messages = entry.state.llmMessages;
    if (!AgentAbject.conversationHasImages(messages)) return { tier };

    const caps = await this.tierCapabilities();
    if (!caps || caps[tier]?.vision !== false) return { tier };

    // The preferred tier is text-only: try the other think tier first
    const other: 'smart' | 'balanced' = tier === 'smart' ? 'balanced' : 'smart';
    if (caps[other] && caps[other]!.vision !== false) {
      log.info(`Vision routing: '${tier}' model ${caps[tier]?.model} is text-only; thinking on '${other}' for this step`);
      return { tier: other };
    }

    // Then the configured vision fallback model
    const fb = caps.visionFallback;
    if (fb && fb.model && fb.vision !== false) {
      log.info(`Vision routing: no vision-capable think tier; using vision fallback ${fb.provider}/${fb.model} for this step`);
      return { tier, provider: fb.provider, model: fb.model };
    }

    // Nothing can see: strip the images so a text-only model doesn't reject the request
    const replaced = AgentAbject.stripImageParts(messages);
    if (replaced > 0) {
      log.warn(`Vision routing: no vision-capable think tier or fallback configured; replaced ${replaced} image part(s) with text notes`);
    }
    return { tier };
  }

  private async think(entry: TaskEntry): Promise<AgentAction> {
    const task = entry.state;

    // Initialize conversation if empty
    if (task.llmMessages.length === 0) {
      task.llmMessages = await this.initializeConversation(entry);
    }

    // Add observation
    this.addObservationToConversation(entry);

    // Add last action result
    this.addActionResultToConversation(entry);

    // Vision-aware tiering runs before trim so a text-only path never
    // carries image bytes into compression either
    const route = await this.applyVisionTiering(entry, this.resolveThinkTier(entry.observeTier));

    // Trim conversation (may do an LLM-compressor pass when over byte budget)
    await this.trimConversation(entry);

    this.llmId = await this.resolveDep('LLM', this.llmId);
    // Use streaming — llmChunk events are forwarded to the ticket caller
    this.activeStreamEntry = entry;
    let llmResult: { content: string; stopReason?: string };
    try {
      llmResult = await this.request<{ content: string; stopReason?: string }>(
        request(this.id, this.llmId, 'stream', {
          messages: task.llmMessages,
          // Thinking is the JSON-action-decision step. Tier comes from the
          // agent's per-state observe hint, floored at 'balanced' (never 'fast'
          // — haiku drops the action envelope under load), then adjusted for
          // vision when the conversation carries images (possibly routing to
          // the configured vision-fallback model via provider+model override).
          // Routine/verification states run on balanced; hard states (code
          // gen, error recovery, planning) stay on smart.
          ...(route.provider ? { provider: route.provider } : {}),
          options: {
            tier: route.tier,
            ...(route.model ? { model: route.model } : {}),
            maxTokens: 16384,
            cacheKey: entry.state.id,
          },
        }),
        120000,
      );
    } finally {
      this.activeStreamEntry = undefined;
    }

    const agentName = this.registeredAgents.get(entry.agentId)?.name ?? 'Unknown';

    // Empty / whitespace-only LLM responses are NOT a parse failure — the
    // service returned nothing to parse. Treat as a transient issue: do not
    // pollute llmMessages with an empty assistant turn (Anthropic dislikes
    // it), and retry with the same prompt (no correction injected, since
    // there's nothing for the LLM to correct).
    const trimmedContent = (llmResult.content ?? '').trim();
    if (trimmedContent.length === 0) {
      entry.emptyResponses = (entry.emptyResponses ?? 0) + 1;
      log.warn(
        `[${agentName}] Step ${task.step + 1} — LLM returned empty content ` +
          `(attempt ${entry.emptyResponses}/${AgentAbject.MAX_EMPTY_RESPONSES}). ` +
          `Likely a transient provider issue or an unhandled content-block type.`,
      );
      if (entry.emptyResponses <= AgentAbject.MAX_EMPTY_RESPONSES) {
        return { action: '_reparse', reasoning: `LLM returned empty content (attempt ${entry.emptyResponses}/${AgentAbject.MAX_EMPTY_RESPONSES}); retrying without correction` };
      }
      const errorTerminal = Object.entries(entry.config.terminalActions).find(([, v]) => v.type === 'error')?.[0];
      const reason = `LLM returned empty content ${entry.emptyResponses} times in a row; aborting. This is usually a provider-side issue (rate limit, content moderation, or an unhandled streaming block type) — check the LLM provider logs.`;
      if (errorTerminal) return { action: errorTerminal, reason, error: reason };
      entry.state.error = reason;
      return { action: '_reparse_abort', reasoning: reason };
    }

    // Reset empty-response counter on a non-empty turn.
    entry.emptyResponses = 0;

    // Add assistant response
    task.llmMessages.push({ role: 'assistant', content: llmResult.content });

    // 'max_tokens'/'length' means the provider cut the response off
    // mid-generation, so even a parseable action carries incomplete content.
    const streamTruncated = llmResult.stopReason === 'max_tokens' || llmResult.stopReason === 'length';
    const parsed = this.parseAction(entry, llmResult.content, streamTruncated);
    log.info(`[${agentName}] Step ${task.step + 1} — LLM action: ${parsed.action}${parsed.reasoning ? ' (' + parsed.reasoning.slice(0, 60) + ')' : ''}`);
    return parsed;
  }


  // ═══════════════════════════════════════════════════════════════════
  // Goal Context
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Build a text summary of goal + task progress for injection into the LLM context.
   * Returns empty string if no goal or no tasks.
   */
  private async buildGoalProgressContext(goalId: string, dispatchTupleId?: string): Promise<string> {
    if (!this.goalManagerId) return '';
    try {
      const goal = await this.request<{
        title?: string; description?: string; status?: string;
        scratchpad?: Record<string, unknown>;
      } | null>(
        request(this.id, this.goalManagerId, 'getGoal', { goalId }),
        5000,
      );

      const tasks = await this.request<Array<{ id: string; fields: Record<string, unknown> }>>(
        request(this.id, this.goalManagerId, 'getTasksForGoal', { goalId }),
        5000,
      );
      if (!tasks || tasks.length === 0) return '';

      // Identify the current task (the one this agent is working on) and its contract,
      // if the caller passed a dispatchTupleId. The contract lets us focus the rendered
      // scratchpad on just the keys this task will consume, and tells the agent which
      // keys it is expected to produce.
      const currentTask = dispatchTupleId ? tasks.find(t => t.id === dispatchTupleId) : undefined;
      const currentProduces = (currentTask?.fields.produces as Array<{ key: string; description: string }> | undefined) ?? [];
      const currentConsumes = (currentTask?.fields.consumes as string[] | undefined) ?? [];

      const lines: string[] = [];
      for (const t of tasks) {
        const status = t.fields.status as string ?? 'unknown';
        const desc = (t.fields.description as string ?? '').slice(0, 200);
        const icon = status === 'done' ? '\u2713' : status === 'permanently_failed' ? '\u2717' : '\u25CB';
        let line = `  ${icon} [${status}] ${desc}`;
        // Skip the inline result dump for prior tasks that declared produces: those
        // findings live in the scratchpad and are surfaced there (either via the
        // consumed-keys block or via the auto-mirror path tasks/<id>/result).
        const taskProduces = (t.fields.produces as Array<{ key: string; description: string }> | undefined) ?? [];
        if (status === 'done' && t.fields.result && taskProduces.length === 0) {
          line += ` -- Result: ${JSON.stringify(t.fields.result).slice(0, 20000)}`;
        } else if (status === 'done' && taskProduces.length > 0) {
          line += ` -- Wrote scratchpad keys: ${taskProduces.map(p => p.key).join(', ')}`;
        }
        if (status === 'permanently_failed' && t.fields.error) {
          line += ` -- Error: ${String(t.fields.error).slice(0, 2000)}`;
        }
        lines.push(line);
      }

      let ctx = `\n\n## Goal Progress\nGoal: "${goal?.title ?? goalId}"`;
      // The user's intent (goal description) — without this, the agent only
      // sees the short title and its individual task description, missing the
      // surrounding context of WHY the work is being done. Adding the
      // description here lets the agent reason about its task in light of
      // the larger goal (and reject scope creep, replan if its task is
      // misaligned, etc.).
      if (goal?.description && goal.description.trim() && goal.description.trim() !== (goal.title ?? '').trim()) {
        ctx += `\nUser's intent:\n${goal.description}`;
      }
      ctx += `\nTasks:\n${lines.join('\n')}`;
      ctx += `\n\nUse this progress to guide your actions. If tasks have failed, consider whether to retry with a different approach (replan) or work with partial results.`;

      // Current task's contract: what it must write, what it will read.
      if (currentProduces.length > 0 || currentConsumes.length > 0) {
        ctx += `\n\n## Your Task's Contract`;
        if (currentProduces.length > 0) {
          ctx += `\n\nThis task is expected to write the following scratchpad keys before reporting done. Write each one with GoalManager's writeGoalData method, invoked through your normal action — \`call("GoalManager", "writeGoalData", {goalId, key, value})\` — NOT a top-level \`writeGoalData\` action verb. Keep the \`done\` result as a short human-readable summary; downstream tasks will read the structured data from the scratchpad.`;
          for (const p of currentProduces) {
            ctx += `\n- **${p.key}**: ${p.description}`;
          }
        }
        if (currentConsumes.length > 0) {
          ctx += `\n\nThis task consumes the following scratchpad keys written by earlier tasks. Their current values are shown in the Shared Goal Data block below.`;
          for (const k of currentConsumes) {
            ctx += `\n- **${k}**`;
          }
        }
      }

      // Scratchpad rendering: when the current task declared consumes, show only
      // those keys (full values). Otherwise fall back to the full scratchpad dump
      // for backward compatibility with tasks that have no contract.
      const scratchpad = goal?.scratchpad;
      if (scratchpad && Object.keys(scratchpad).length > 0) {
        if (currentConsumes.length > 0) {
          const consumed: Record<string, unknown> = {};
          for (const k of currentConsumes) {
            if (k in scratchpad) consumed[k] = scratchpad[k];
          }
          const missing = currentConsumes.filter(k => !(k in scratchpad));
          if (Object.keys(consumed).length > 0) {
            ctx += `\n\n## Shared Goal Data (consumed keys)\nValues at the scratchpad keys this task consumes.\n\`\`\`json\n${JSON.stringify(consumed, null, 2)}\n\`\`\``;
          }
          if (missing.length > 0) {
            ctx += `\n\nConsumed keys not yet written: ${missing.join(', ')}. Earlier tasks should have produced these; if they are missing, the auto-mirror at tasks/<taskId>/result may hold the raw completion output as a fallback.`;
          }
        } else {
          ctx += `\n\n## Shared Goal Data (scratchpad)\nOther agents working on this goal have shared the following data. Add your own findings with \`call("GoalManager", "writeGoalData", {goalId, key, value})\` (a GoalManager method, not a top-level action verb).\n\`\`\`json\n${JSON.stringify(scratchpad, null, 2)}\n\`\`\``;
        }
      }

      return ctx;
    } catch {
      return '';
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Conversation Management
  // ═══════════════════════════════════════════════════════════════════

  private async initializeConversation(entry: TaskEntry): Promise<{ role: string; content: string | ContentPart[] }[]> {
    const messages: { role: string; content: string | ContentPart[] }[] = [];

    let prompt = entry.systemPrompt;
    if (entry.skillPromptSuffix) {
      prompt += entry.skillPromptSuffix;
    }
    if (entry.responseSchema) {
      prompt += `\n\n## Response Schema\nWhen you complete the task, the "result" field of your terminal action MUST be a JSON object (not a string) conforming to this schema:\n\`\`\`json\n${JSON.stringify(entry.responseSchema, null, 2)}\n\`\`\`\nIMPORTANT: The "result" value must be a structured JSON object, NOT a string. Include all required fields. Use exact property names from the schema.`;
    }

    // Inject goal + task progress and scratchpad into context
    if (entry.goalId && this.goalManagerId) {
      prompt += await this.buildGoalProgressContext(entry.goalId, entry.dispatchTupleId);
    }

    // Inject relevant knowledge from KnowledgeBase in two passes:
    //   1. Durable user-profile facts (PROFILE_TAG), always included regardless
    //      of the task wording, so stable knowledge about the user (home
    //      location, name, preferences) is present even when the task shares no
    //      keywords with it — keyword recall alone would rank it out of the top
    //      results and the agent would re-ask for something it already knows.
    //   2. The top entries whose text matches this task.
    // A profile fact that also matches the query is not repeated.
    try {
      const knowledgeBaseId = await this.discoverDep('KnowledgeBase');
      if (knowledgeBaseId) {
        type KEntry = { id: string; title: string; type: string; content: string; origin?: string; usefulCount?: number; updatedAt?: number };
        const [profileAll, matched, tagList] = await Promise.all([
          this.request<KEntry[] | null>(
            request(this.id, knowledgeBaseId, 'recall', { tags: [PROFILE_TAG], limit: 50 }),
            5000,
          ).catch(() => null),
          this.request<KEntry[] | null>(
            request(this.id, knowledgeBaseId, 'recall', { query: entry.state.task, limit: 5 }),
            5000,
          ).catch(() => null),
          this.request<Array<{ tag: string; count: number }> | null>(
            request(this.id, knowledgeBaseId, 'listTags', { limit: 20 }),
            5000,
          ).catch(() => null),
        ]);
        if (tagList && tagList.length > 0) {
          entry.knownTagsLine = tagList.map(t => `${t.tag} (${t.count})`).join(', ');
        }

        // The profile block is bounded by a char budget, not a raw count,
        // and selection is by worth rather than recency: user-authored
        // facts always make the cut, then reviewer-confirmed-useful ones,
        // then the freshest. Otherwise agents that over-tag 'profile'
        // (project trivia included) crowd the user's actual identity facts
        // out of every future prompt.
        const ranked = [...(profileAll ?? [])].sort((a, b) => {
          const aUser = a.origin === 'user' ? 1 : 0;
          const bUser = b.origin === 'user' ? 1 : 0;
          if (aUser !== bUser) return bUser - aUser;
          const useful = (b.usefulCount ?? 0) - (a.usefulCount ?? 0);
          if (useful !== 0) return useful;
          return (b.updatedAt ?? 0) - (a.updatedAt ?? 0);
        });
        const profile: KEntry[] = [];
        let budget = AgentAbject.PROFILE_BLOCK_CHAR_BUDGET;
        for (const e of ranked) {
          const line = `- **${e.title}**: ${sanitizeInjectedFact(e.content.slice(0, AgentAbject.PROFILE_ENTRY_CHAR_CAP))}\n`;
          if (line.length > budget) break;
          budget -= line.length;
          profile.push(e);
        }

        if (profile.length > 0) {
          let block = '\n\n## About the User\nDurable facts about the user. Apply them without asking the user to repeat them.\n';
          for (const e of profile) {
            block += `- **${e.title}**: ${sanitizeInjectedFact(e.content.slice(0, AgentAbject.PROFILE_ENTRY_CHAR_CAP))}\n`;
          }
          const omitted = (profileAll?.length ?? 0) - profile.length;
          if (omitted > 0) {
            block += `(${omitted} more profile fact${omitted === 1 ? '' : 's'} exist — recall with tags: ["${PROFILE_TAG}"] when you need the full set.)\n`;
          }
          prompt += block;
        }

        const profileTitles = new Set((profile ?? []).map(e => e.title));
        const relevant = (matched ?? []).filter(e => !profileTitles.has(e.title));
        if (relevant.length > 0) {
          let kb = '\n\n## Relevant Knowledge\nPrevious agents have learned the following. Use remember(title, content, type, tags) to save new insights.\n';
          for (const e of relevant) {
            kb += `- **${e.title}** (${e.type}): ${sanitizeInjectedFact(e.content.slice(0, 2000))}\n`;
          }
          prompt += kb;
        }

        // Record what was injected so the post-task reviewer can judge which
        // entries actually helped (KnowledgeBase.markUseful).
        entry.injectedKnowledge = [...(profile ?? []), ...relevant]
          .filter(e => e.id)
          .map(e => ({ id: e.id, title: e.title }));
      }
    } catch { /* best effort */ }

    // Always-present guidance on how object identity works. Agents reference
    // objects constantly (in goals, scratchpad, calls, and saved knowledge);
    // they need to know which handle survives a restart and which does not.
    prompt += `\n\n## Object identity
Every Abject has two kinds of handle:
- Its **registered name** (e.g. "GraphViewer") and its **typeId** are DURABLE — they persist across restarts and always point at the live object.
- Its **AbjectId** (a UUID like \`adac6cc1-...\`) is EPHEMERAL — objects are re-spawned with a fresh AbjectId every time they are restored on restart, so a UUID copied from an earlier goal, scratchpad, or saved memory is usually stale and resolves to nothing.

Reference objects by their registered name wherever possible — name-based calls and lookups always reach the live object. When you write a goal, hand off a target, or save a fact about an object, use its name (and typeId if you have one), not its UUID.`;

    // Always-present guidance on memory tools
    prompt += `\n\n## Memory Tools

**remember** action (persistent across all goals and restarts):
You can emit a remember action to save knowledge for future tasks:
\`\`\`json
{ "action": "remember", "title": "short summary", "content": "detailed knowledge", "type": "fact", "tags": ["tag1", "tag2"] }
\`\`\`
Types: 'learned' (lessons from outcomes), 'fact' (discovered facts), 'insight' (analysis), 'reference' (pointers)
When to remember (durable knowledge for future unrelated tasks):
- User preferences or personal facts they share (location, name, job, etc.) — tag these with "profile" so they are always available in future tasks, even ones whose wording does not mention them
- Stable system architecture insights or validated patterns
- Useful API details or capabilities that are unlikely to change

The "profile" tag is reserved for WHO THE USER IS: name, location, role, preferences, accounts they use. Facts ABOUT their projects, writings, or interests are still worth remembering, with topical tags — keyword recall surfaces them when relevant. Every profile-tagged entry competes for a small always-injected block in every future prompt, so tagging trivia "profile" crowds out the user's actual identity.
Ephemeral problems (runtime errors, connection failures, config issues, workarounds being tried) belong in the goal scratchpad, not the knowledge base. They are relevant to the current goal only.
After remembering, you will be prompted to continue with the task.

**recall** action (look things up mid-task, available alongside your other actions):
\`\`\`json
{ "action": "recall", "query": "keywords to search" }
\`\`\`
Variants: \`{ "action": "recall", "pattern": "ExactName|other" }\` for exact identifiers, \`{ "action": "recall", "id": "<entry id>" }\` to fetch one full entry, \`{ "action": "recall", "tags": ["profile"] }\` to list by tag. Keyword results are compact previews (id, title, snippet); refine your terms when results are thin, then fetch the full entries you will actually use by id. Recall when a task resembles previous work, when you are unsure of user preferences or conventions, and before re-deriving anything the system may already know.`;

    if (entry.knownTagsLine) {
      prompt += `\nTags currently in use (with entry counts) — reuse these when remembering, and filter by them when recalling: ${entry.knownTagsLine}`;
    }

    // Guidance on the built-in submit_job verb. Safe to state for every
    // agent because the verb is handled by the runtime itself (like
    // `remember`), not by the agent's own action switch.
    prompt += `\n\n## Mechanical pipelines (submit_job)

**submit_job** action (built-in, available alongside your other actions):
\`\`\`json
{ "action": "submit_job", "description": "what it does", "code": "<javascript>" }
\`\`\`
The code runs in a sandboxed job. Inside it you have \`call(id, method, payload)\` to message any object, \`dep(name)\` (resolve an object by name, throws if missing), and \`find(name)\` (resolve or null). \`return\` a value and it comes back as this single action's result.

Use it when your next chunk of work is a mechanical multi-step sequence with no judgment needed between steps: fetch N items, transform each, aggregate; poll-then-collect; bulk reads. One job costs one step, however many calls it makes, where doing the same through individual actions costs a step each. Example:
\`\`\`json
{ "action": "submit_job", "description": "summarize open goals", "code": "const gm = await dep('GoalManager'); const goals = await call(gm, 'listGoals', {}); return goals.filter(g => g.status === 'active').map(g => g.title);" }
\`\`\`
Keep the return value small — aggregate or summarize inside the job instead of returning raw bulk data (results are truncated past 20k chars). Use your regular actions when each step's outcome should change what you do next; use one job when it wouldn't. Your own domain actions (browsing, shell, drafting) stay as actions — the job sandbox has no browser, no shell, and no filesystem, only object messaging.

Object names in job code must be EXACT registered object names as they appear in your context (goals, scratchpad, registry listings) — a skill, service, or server name is not an object name. When unsure a name exists, use \`find(name)\` and handle null instead of \`dep(name)\`, which fails the whole job. Anything you reach through a dedicated action of yours (like a tool-call action) has no object of that name on the bus; keep using your action for it.`;

    if (entry.goalId) {
      prompt += `

## Goal context
This task belongs to a goal whose id is \`${entry.goalId}\` — you never need to look it up, scan \`listGoals\`, or guess a goalId; use this one. GoalManager owns the goal and a scratchpad shared by every agent working on it. You reach GoalManager the same way you reach any object: through your normal action vocabulary (for most agents that is a \`call\` action targeting "GoalManager"; some agents also expose a dedicated scratchpad action). These are GoalManager METHODS — invoke them through your actions, they are not free-standing functions you call directly. Each takes the goalId above:
- \`getGoal({goalId})\` / \`getTasksForGoal({goalId, status})\` -- read the goal and its tasks
- \`updateProgress({goalId, message, phase})\` -- report progress
- \`writeGoalData({goalId, key, value})\` / \`readGoalData({goalId, key})\` -- the shared scratchpad

**Goal scratchpad** (shared with the other agents on this goal): write intermediate findings, specs, and errors here so collaborators can read them, and fulfill each of your task's declared \`produces\` keys by writing it to the scratchpad (\`writeGoalData\`). Read \`consumes\` data the same way (\`readGoalData\`). Prefer the scratchpad over \`remember\` for anything tied to the current task.

**Finishing your work:** end your loop with your terminal \`done\` (or \`fail\`) action describing what YOUR task accomplished. That is the whole report — the system records your task's outcome from it. Deciding whether the overall GOAL is then complete, needs more tasks, or has failed belongs to the scrum process, which reviews each round's outcomes and scratchpad and chooses to add tasks, complete, or fail the goal. So focus on your task and report it cleanly. (Calling GoalManager's \`completeGoal\` / \`failGoal\` / \`addTask\` yourself is only for the separate case where you own a goal end-to-end with no scrum running it; reserve them for that.)`;
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

    // Cap at ingestion — a single fat observation (a Registry dump, a
    // scraped page, a scratchpad readback) must never ride into the prompt
    // whole. Action results get the same treatment in
    // addActionResultToConversation; the budget enforcer in trimConversation
    // is the backstop for everything else.
    const observation = truncateText(task.observation, AgentAbject.MAX_OBSERVATION_CHARS);

    task.llmMessages.push({
      role: 'user',
      content: `[Step ${task.step + 1}/${task.maxSteps}]${urgency}\n${observation}`,
    });
  }

  private addActionResultToConversation(entry: TaskEntry): void {
    const task = entry.state;
    if (!task.lastResult) return;

    const action = task.action;
    let resultStr: string;
    if (task.lastResult.success) {
      resultStr = `Action "${action?.action}" succeeded: ${JSON.stringify(task.lastResult.data)?.slice(0, 30000) ?? 'ok'}`;
    } else {
      // On failure, include any partial `data` alongside the error. Callers
      // like Chat's `goal` action attach scratchpad/successful sub-task
      // results to the failure payload so the next think-step can still
      // use what was learned before the stall. Dropping data here causes
      // the LLM to synthesise generic "everything timed out" replies
      // instead of using the real findings.
      const errStr = String(task.lastResult.error ?? 'unknown error');
      const dataStr = task.lastResult.data !== undefined
        ? `\nPartial data (from sub-tasks that succeeded):\n${JSON.stringify(task.lastResult.data)?.slice(0, 30000) ?? ''}`
        : '';
      resultStr = `Action "${action?.action}" failed: ${errStr}${dataStr}`;
    }

    task.llmMessages.push({ role: 'user', content: `[Action Result]\n${resultStr}` });
  }

  /** Whole-conversation byte budget. Above this, the middle block is
   *  distilled by a fast-tier LLM pass and replaced with a single synthetic
   *  summary message. 180k chars ≈ 45k tokens — well under every provider's
   *  context window, leaves headroom for the current observation + response. */
  private static readonly MAX_CONVERSATION_CHARS = 180000;
  /** How many recent messages to keep verbatim after compression. Covers the
   *  current observation, the current action, and the prior action cycle. */
  private static readonly KEEP_RECENT_MESSAGES = 4;
  /** Per-observation cap applied at ingestion (head+tail slice). */
  private static readonly MAX_OBSERVATION_CHARS = 60000;
  /** Floor below which the budget enforcer stops shrinking a message. With
   *  maxConversationMessages=32, 32 × 4k = 128k < MAX_CONVERSATION_CHARS, so
   *  enforcement always converges. */
  private static readonly TRUNCATION_FLOOR_CHARS = 4000;

  private async trimConversation(entry: TaskEntry): Promise<void> {
    const task = entry.state;
    const maxMsgs = entry.config.maxConversationMessages;
    const pinnedCount = entry.config.pinnedMessageCount;

    // 1. Count cap — cheap, always apply first.
    if (task.llmMessages.length > maxMsgs) {
      const pinned = task.llmMessages.slice(0, pinnedCount);
      const recent = task.llmMessages.slice(-(maxMsgs - pinnedCount));
      task.llmMessages = [...pinned, ...recent];
    }

    // 2. Byte cap — only kick in if the conversation blew past the budget
    //    (e.g. an accidental Registry.list dump). Delegate to the LLM
    //    object's `compress` method: it split-distills oversized messages
    //    with the fast tier, summarizes the middle block, and falls back to
    //    deterministic truncation internally.
    if (conversationTextChars(task.llmMessages) <= AgentAbject.MAX_CONVERSATION_CHARS) {
      return;
    }

    try {
      this.llmId = await this.resolveDep('LLM', this.llmId);
      const result = await this.request<{ messages: typeof task.llmMessages; originalChars: number; compressedChars: number; methods: string[] }>(
        request(this.id, this.llmId, 'compress', {
          messages: task.llmMessages,
          options: {
            targetChars: AgentAbject.MAX_CONVERSATION_CHARS,
            pinnedCount,
            keepRecent: AgentAbject.KEEP_RECENT_MESSAGES,
            taskHint: entry.state.task,
          },
        }),
        120000,
      );
      task.llmMessages = result.messages;
      log.info(`trimConversation: compressed ${result.originalChars} → ${result.compressedChars} chars (${result.methods.join('+')})`);
    } catch (err) {
      // Compression unavailable (LLM gone, timeout) — losing raw history
      // beats a 400. Drop the middle block, then enforce the budget locally.
      log.warn(`trimConversation: compress failed (${err instanceof Error ? err.message : String(err)}) — falling back to local truncation`);
      const keepRecent = AgentAbject.KEEP_RECENT_MESSAGES;
      const middleEnd = Math.max(pinnedCount, task.llmMessages.length - keepRecent);
      if (middleEnd > pinnedCount) {
        const dropped = middleEnd - pinnedCount;
        task.llmMessages = [
          ...task.llmMessages.slice(0, pinnedCount),
          { role: 'user', content: `[Earlier context dropped: ${dropped} messages elided to fit context budget]` },
          ...task.llmMessages.slice(middleEnd),
        ];
      }
    }

    // 3. Budget guarantee, no matter which path ran above. Deterministically
    //    shrink the largest messages, wherever they sit (a fat system prompt
    //    or a fat message in the keep-recent window is exactly how a
    //    3.1M-char prompt once reached the API as a 400).
    enforceConversationCharBudget(
      task.llmMessages,
      AgentAbject.MAX_CONVERSATION_CHARS,
      AgentAbject.TRUNCATION_FLOOR_CHARS,
    );
  }

  // ═══════════════════════════════════════════════════════════════════
  // Action Parsing
  // ═══════════════════════════════════════════════════════════════════

  /** Maximum consecutive unparseable LLM responses before we force a terminal fail. */
  private static readonly MAX_PARSE_FAILURES = 2;
  /** Maximum consecutive empty LLM responses before we force a terminal fail. */
  private static readonly MAX_EMPTY_RESPONSES = 3;

  /** Maximum re-emit attempts for a terminal action cut off mid-generation. */
  private static readonly MAX_TRUNCATION_RETRIES = 1;

  /**
   * Handle a terminal action recovered from a truncated (cut-off) response.
   * Returns a `_reparse` sentinel to request a complete re-emit, or null to
   * proceed with the action. On the final attempt the partial content is kept
   * (so the user sees something) but marked as cut off rather than passed off
   * as a complete reply. Non-terminal actions are left to fail/observe normally.
   */
  private handleTruncatedAction(entry: TaskEntry, parsed: AgentAction): AgentAction | null {
    const terminal = entry.config.terminalActions[parsed.action];
    if (!terminal) return null;

    entry.truncationRetries = (entry.truncationRetries ?? 0) + 1;
    if (entry.truncationRetries <= AgentAbject.MAX_TRUNCATION_RETRIES) {
      entry.state.llmMessages.push({
        role: 'user',
        content: `[Error] Your "${parsed.action}" response was cut off mid-generation (the output ended incompletely or hit the length limit). Re-emit the COMPLETE action as a single \`\`\`json block. If the content is long, make it more concise so it finishes within the limit rather than getting truncated again.`,
      });
      return { action: '_reparse', reasoning: `Retrying truncated "${parsed.action}" terminal (attempt ${entry.truncationRetries}/${AgentAbject.MAX_TRUNCATION_RETRIES})` };
    }

    // Retries exhausted: ship the partial content rather than nothing, but mark
    // it so a cut-off reply is never mistaken for a complete one.
    for (const field of (terminal.resultFields ?? [])) {
      const val = parsed[field];
      if (typeof val === 'string' && val.trim().length > 0) {
        parsed[field] = `${val}\n\n_(Response was cut off.)_`;
        break;
      }
    }
    entry.truncationRetries = 0;
    return null;
  }

  /**
   * Returns null if the parsed action has acceptable content, or a `_reparse`
   * sentinel (or terminal error) if the agent should be asked to try again.
   *
   * Currently checks: terminal actions whose configured `resultFields` are all
   * missing or empty. Example: `clarify` is registered with `resultFields:
   * ['question']`; an LLM that emits `{"action": "clarify"}` with no question
   * would succeed silently and the user would see nothing. We reject such
   * empty terminals and ask the LLM to fill in at least one field.
   */
  private validateActionContent(entry: TaskEntry, parsed: AgentAction): AgentAction | null {
    const terminal = entry.config.terminalActions[parsed.action];
    if (!terminal) return null;
    const fields = terminal.resultFields ?? [];
    if (fields.length === 0) return null;

    const hasContent = fields.some(field => {
      const val = parsed[field];
      if (val === undefined || val === null) return false;
      if (typeof val === 'string') return val.trim().length > 0;
      // Object / array / number / boolean — present but maybe empty:
      if (typeof val === 'object') {
        if (Array.isArray(val)) return val.length > 0;
        return Object.keys(val as object).length > 0;
      }
      return true;
    });
    if (hasContent) return null;

    entry.parseFailures = (entry.parseFailures ?? 0) + 1;
    if (entry.parseFailures <= AgentAbject.MAX_PARSE_FAILURES) {
      const fieldList = fields.map(f => `"${f}"`).join(', ');
      const example: AgentAction = { action: parsed.action };
      example[fields[0]] = `<your ${fields[0]} here>`;
      const correction = `[Error] Your "${parsed.action}" action arrived with no content in any of the required fields (${fieldList}). At least one must be a non-empty string (or non-empty object/array). Without it the user sees nothing. Re-emit the action with the field populated, e.g.:\n\`\`\`json\n${JSON.stringify(example)}\n\`\`\``;
      entry.state.llmMessages.push({ role: 'user', content: correction });
      return { action: '_reparse', reasoning: `Retrying empty "${parsed.action}" terminal (attempt ${entry.parseFailures}/${AgentAbject.MAX_PARSE_FAILURES})` };
    }

    // Retries exhausted — fall back to the agent's error terminal so the
    // caller hears about the failure instead of getting silent success.
    const errorTerminal = Object.entries(entry.config.terminalActions).find(([, v]) => v.type === 'error')?.[0];
    const reason = `LLM emitted "${parsed.action}" with empty content in all required fields (${fields.join(', ')}) ${entry.parseFailures} times in a row; aborting.`;
    if (errorTerminal) {
      return { action: errorTerminal, reason, error: reason };
    }
    entry.state.error = reason;
    return { action: '_reparse_abort', reasoning: reason };
  }

  private parseAction(entry: TaskEntry, content: string, streamTruncated = false): AgentAction {
    // Extract a parsed action from the content (try several wrapper shapes).
    // `repaired` is set when the action was salvaged from incomplete JSON
    // (suffix-closing or regex extraction) — a strong truncation signal even
    // when the provider didn't report stop_reason.
    let parsed: AgentAction | null = null;
    let repaired = false;
    const take = (r: { action: AgentAction; repaired: boolean } | null) => {
      if (r && !parsed) { parsed = r.action; repaired = r.repaired; }
    };

    // Every parse replaces the batch queue — a stale queue from a previous
    // turn must never drain against a newer LLM decision.
    entry.pendingActions = undefined;

    // 1. String-aware balanced-brace extraction — the robust primary path.
    //    Handles action JSON whose string values contain ``` code fences or
    //    `{`/`}` characters, which the lazy ```json fence regex below would
    //    mis-cut at the first inner fence (turning a complete reply into a
    //    truncated one). Skipped strings/escapes mean inner fences and braces
    //    don't confuse the scan.
    //    The LLM may batch several independent actions in one response; the
    //    first is returned as usual and the rest queue for the drain path.
    const balancedObjects = this.extractAllBalancedJson(content);
    const balanced = balancedObjects[0] ?? null;
    if (balanced) take(this.tryParseActionJson(balanced));
    const primaryFromBalancedScan = parsed !== null;

    // 2. Fenced ```json block (lazy — fine once balanced extraction has had
    //    first refusal, used mainly when there is no balanced object to find).
    if (!parsed) {
      const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
      if (jsonMatch) take(this.tryParseActionJson(jsonMatch[1].trim()));
    }
    // 3. Unclosed ```json fence (genuinely truncated mid-block).
    if (!parsed) {
      const unclosedMatch = content.match(/```json\s*([\s\S]*)/);
      if (unclosedMatch) take(this.tryParseActionJson(unclosedMatch[1].trim()));
    }
    // 4. Whole content as a last resort.
    if (!parsed) {
      take(this.tryParseActionJson(content));
    }

    if (parsed) {
      // A terminal action salvaged from a cut-off stream carries incomplete
      // text/result. Re-prompt for a complete re-emit (then fall back to the
      // partial with a visible marker) BEFORE the empty-content check, so a
      // half-message is never silently promoted to a successful reply.
      if (streamTruncated || repaired) {
        const truncatedHandling = this.handleTruncatedAction(entry, parsed);
        if (truncatedHandling) return truncatedHandling;
      } else {
        entry.truncationRetries = 0;
      }

      // Reject terminal actions that arrive with all required fields missing
      // or empty. Without this, the framework happily promotes e.g.
      // `{"action": "clarify"}` to a success terminal, but downstream renders
      // an empty bubble and the user sees nothing. Treat empty-terminal as a
      // parse failure so the LLM is asked to retry with the missing content.
      const reparse = this.validateActionContent(entry, parsed);
      if (reparse) return reparse;
      entry.parseFailures = 0;

      // Queue any additional batched actions for the drain path. Only a
      // clean, complete first parse qualifies — a truncated or repaired
      // response means the tail is untrustworthy.
      if (!streamTruncated && !repaired && primaryFromBalancedScan && balancedObjects.length > 1) {
        this.queueBatchedActions(entry, parsed, balancedObjects.slice(1));
      }
      return parsed;
    }

    // No structured action found — this is a parse failure. Track it and
    // either retry (by emitting a _reparse sentinel the main loop handles)
    // or fail the task explicitly. Never silently promote raw prose into a
    // terminal "done" — that makes the LLM's hallucinated summary look like
    // real work.
    entry.parseFailures = (entry.parseFailures ?? 0) + 1;

    const hallucinationPatterns = ['<function_calls>', '<tool_call>', '<invoke name='];
    const hallucinatedTools = hallucinationPatterns.some(p => content.includes(p));

    if (entry.parseFailures <= AgentAbject.MAX_PARSE_FAILURES) {
      const correction = hallucinatedTools
        ? '[Error] You produced XML tool calls, but this system uses JSON actions in ```json code blocks. Respond with a valid JSON action, for example:\n```json\n{"action": "done", "result": "..."}\n```'
        : '[Error] Your previous response was not a valid action. You must respond with a single ```json code block containing an action object. Example:\n```json\n{"action": "done", "result": "your final answer"}\n```\nor, to abort:\n```json\n{"action": "fail", "reason": "why you cannot continue"}\n```';
      entry.state.llmMessages.push({ role: 'user', content: correction });
      return { action: '_reparse', reasoning: `Retrying after unparseable response (attempt ${entry.parseFailures}/${AgentAbject.MAX_PARSE_FAILURES})` };
    }

    // Retries exhausted — force a terminal failure using whichever error
    // terminal this agent has configured (typically "fail").
    const errorTerminal = Object.entries(entry.config.terminalActions).find(([, v]) => v.type === 'error')?.[0];
    const preview = content.trim().slice(0, 200).replace(/\s+/g, ' ');
    const reason = `LLM produced unparseable output ${entry.parseFailures} times in a row; aborting. Last response began: "${preview}${content.length > 200 ? '…' : ''}"`;
    if (errorTerminal) {
      return { action: errorTerminal, reason, error: reason };
    }
    // No error terminal configured — synthesize a generic failed state.
    entry.state.error = reason;
    return { action: '_reparse_abort', reasoning: reason };
  }

  /** Maximum actions honored from a single LLM response (the first + queued extras). */
  private static readonly MAX_BATCH_ACTIONS = 5;

  /**
   * Queue actions 2..N of a multi-action LLM response for the thinking-phase
   * drain. Terminals and conversation-steering verbs (replan / remember /
   * ask_user) are excluded — they only make sense once the model has seen the
   * batch results — as are duplicates, unparseable extras, and anything past
   * MAX_BATCH_ACTIONS. Meaningful exclusions are surfaced to the model as
   * [Batch] notes so a dropped `done` is never a silent no-op.
   */
  private queueBatchedActions(entry: TaskEntry, first: AgentAction, extraRaw: string[]): void {
    const queue: AgentAction[] = [];
    const seen = new Set<string>([JSON.stringify(first)]);
    const droppedSpecials: string[] = [];
    let overflow = 0;

    for (const raw of extraRaw) {
      const r = this.tryParseActionJson(raw);
      if (!r || r.repaired) continue; // extras get no repair attempts
      const a = r.action;
      if (a.action.startsWith('_')) continue;
      const isTerminal = !!entry.config.terminalActions[a.action];
      const isSteering = ['replan', 'remember', 'recall', 'ask_user', 'submit_job'].includes(a.action);
      if (isTerminal || isSteering) {
        droppedSpecials.push(a.action);
        continue;
      }
      const key = JSON.stringify(a);
      if (seen.has(key)) continue;
      seen.add(key);
      if (1 + queue.length >= AgentAbject.MAX_BATCH_ACTIONS) {
        overflow++;
        continue;
      }
      queue.push(a);
    }

    if (droppedSpecials.length > 0) {
      entry.state.llmMessages.push({
        role: 'user',
        content: `[Batch] Your response included "${droppedSpecials.join('", "')}" after other actions. It was not executed — you emitted it before seeing the results of the actions ahead of it. Review those results first, then emit it alone.`,
      });
    }
    if (overflow > 0) {
      entry.state.llmMessages.push({
        role: 'user',
        content: `[Batch] ${overflow} action(s) beyond the limit of ${AgentAbject.MAX_BATCH_ACTIONS} per response were discarded — re-emit them next turn if still needed.`,
      });
    }
    if (queue.length > 0) {
      entry.pendingActions = queue;
      const agentName = this.registeredAgents.get(entry.agentId)?.name ?? 'Unknown';
      log.info(`[${agentName}] Multi-action response: executing "${first.action}" now, ${queue.length} more queued (${queue.map(a => a.action).join(', ')})`);
    }
  }

  /**
   * Extract the first complete, brace-balanced JSON object from `content`,
   * scanning string literals so that `{`, `}`, and ``` code fences appearing
   * inside string values (e.g. a markdown answer in a "text" field) do not
   * terminate the object early. Returns the object substring, or null if no
   * `{` is found or the braces never balance (a genuinely truncated object,
   * which the caller's later fallbacks handle).
   */
  private extractBalancedJson(content: string): string | null {
    return this.extractAllBalancedJson(content, 1)[0] ?? null;
  }

  /**
   * Extract every complete, brace-balanced top-level JSON object from
   * `content`, in order, using the same string/escape-aware scan as
   * extractBalancedJson. A trailing object whose braces never balance
   * (truncated mid-stream) is omitted. `limit` bounds how many objects are
   * collected.
   */
  private extractAllBalancedJson(content: string, limit = Infinity): string[] {
    const objects: string[] = [];
    let start = content.indexOf('{');
    while (start !== -1 && objects.length < limit) {
      let depth = 0;
      let inString = false;
      let escaped = false;
      let end = -1;
      for (let i = start; i < content.length; i++) {
        const ch = content[i];
        if (escaped) { escaped = false; continue; }
        if (inString) {
          if (ch === '\\') escaped = true;
          else if (ch === '"') inString = false;
          continue;
        }
        if (ch === '"') inString = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end === -1) break;
      objects.push(content.slice(start, end + 1));
      start = content.indexOf('{', end + 1);
    }
    return objects;
  }

  private tryParseActionJson(raw: string): { action: AgentAction; repaired: boolean } | null {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.action === 'string') {
        return { action: parsed as AgentAction, repaired: false };
      }
    } catch {
      // Try repairing truncated JSON — these salvage paths mean the original
      // content was incomplete, which the caller treats as a truncation signal.
      const suffixes = ['"}', '"}]', '}}', '}'];
      for (const suffix of suffixes) {
        try {
          const repaired = JSON.parse(raw + suffix);
          if (typeof repaired.action === 'string') return { action: repaired as AgentAction, repaired: true };
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
        return { action, repaired: true };
      }
    }
    return null;
  }

  /**
   * Propagate low-level PROGRESS bubbles up to GoalManager as
   * `updateProgress` events so higher layers that watch `goalUpdated`
   * (notably Chat's `waitForTaskCompletion`) stay alive during long
   * downstream calls. Throttled per-goal so streaming LLM chunks don't
   * flood the bus.
   */
  /** Most recent terminal (done/error) task entries retained for review. */
  private static readonly MAX_TERMINAL_ENTRIES = 200;

  /**
   * Drop the oldest terminal task entries beyond the retention cap.
   * taskOrder is newest-first (createTask unshifts), so walk it from the
   * tail. Non-terminal entries are always kept.
   */
  private pruneTerminalEntries(): void {
    let terminal = 0;
    for (const id of this.taskOrder) {
      const e = this.taskEntries.get(id);
      if (e?.finished) terminal++;
    }
    if (terminal <= AgentAbject.MAX_TERMINAL_ENTRIES) return;

    for (let i = this.taskOrder.length - 1; i >= 0 && terminal > AgentAbject.MAX_TERMINAL_ENTRIES; i--) {
      const id = this.taskOrder[i];
      const e = this.taskEntries.get(id);
      if (!e) {
        this.taskOrder.splice(i, 1);
        continue;
      }
      // Only entries whose state machine has exited are prunable; a
      // cancelled-but-still-running machine still touches its entry.
      if (e.finished) {
        this.taskEntries.delete(id);
        this.taskOrder.splice(i, 1);
        terminal--;
      }
    }
  }

  protected override onProgressBubble(_msg: AbjectMessage): void {
    if (!this.goalManagerId) return;
    const now = Date.now();
    for (const entry of this.taskEntries.values()) {
      // Don't emit progress for terminal entries — they're done. Without this,
      // every late LLM chunk or background bubble would re-fire `phase=done` on
      // GoalManager forever, filling the log and blasting UNDELIVERABLE events
      // at every stale dependent (e.g. Chat instances from previous workspace
      // sessions). Terminal entries are bounded by pruneTerminalEntries and
      // released early by the reviewer, so this loop stays small.
      if (entry.state.phase === 'done' || entry.state.phase === 'error') continue;
      const goalId = entry.goalId ?? entry.incomingGoalId;
      if (!goalId) continue;
      const last = this.lastGoalProgressTs.get(goalId) ?? 0;
      if (now - last < AgentAbject.GOAL_PROGRESS_THROTTLE_MS) continue;
      this.lastGoalProgressTs.set(goalId, now);
      try {
        // Echo the current action's reasoning when there is one — a bare
        // "working" carries no information across a minutes-long step.
        const reasoning = typeof entry.state.action?.reasoning === 'string'
          ? entry.state.action.reasoning.trim().slice(0, 140)
          : '';
        this.send(event(this.id, this.goalManagerId, 'updateProgress', {
          goalId,
          message: reasoning || 'working',
          phase: entry.state.phase ?? 'acting',
          agentName: this.registeredAgents.get(entry.agentId)?.name ?? 'agent',
        }));
      } catch { /* bus may be gone */ }
    }
  }
}
