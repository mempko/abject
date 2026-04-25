/**
 * ObjectAgent -- an agent that discovers and calls objects via message passing.
 *
 * Registers with AgentAbject and claims tasks from the
 * TupleSpace. Uses the Registry's ask protocol to discover which objects
 * to talk to, then sends ask/describe/call messages to target objects.
 * All interaction is via message passing through the MessageBus.
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import type { AgentAction } from './agent-abject.js';
import type { ContentPart } from '../llm/provider.js';
import { Log } from '../core/timed-log.js';

const log = new Log('ObjectAgent');

const OBJECT_AGENT_INTERFACE: InterfaceId = 'abjects:object-agent';

interface TaskExtra {
  lastResult?: string;
  lastLlmContent?: ContentPart[];
  taskData?: Record<string, unknown>;
}

export class ObjectAgent extends Abject {
  private agentAbjectId?: AbjectId;
  private jobManagerId?: AbjectId;
  private goalManagerId?: AbjectId;
  private _currentGoalId?: string;

  private taskExtras = new Map<string, TaskExtra>();

  constructor() {
    super({
      manifest: {
        name: 'ObjectAgent',
        description:
          'Agent that discovers and calls objects via message passing. ' +
          'Consults the Registry to find which objects can accomplish a task, ' +
          'asks objects about their API, then sends the right messages. ' +
          'Handles API interactions, data retrieval, and multi-step call chains.',
        version: '1.0.0',
        interface: {
          id: OBJECT_AGENT_INTERFACE,
          name: 'ObjectAgent',
          description: 'Object discovery and message-passing agent',
          methods: [
            {
              name: 'runTask',
              description: 'Discover and call objects to accomplish a task',
              parameters: [
                { name: 'task', type: { kind: 'primitive', primitive: 'string' }, description: 'Task description' },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                result: { kind: 'primitive', primitive: 'string' },
              }},
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.LLM_QUERY, reason: 'LLM planning for object discovery and call orchestration', required: true },
        ],
        providedCapabilities: [],
        tags: ['system', 'agent', 'call'],
      },
    });

    this.setupHandlers();
  }

  protected override async onInit(): Promise<void> {
    this.agentAbjectId = await this.requireDep('AgentAbject');
    this.jobManagerId = await this.discoverDep('JobManager') ?? undefined;
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;

    await this.registerWithAgentAbject();
    log.info('Registered with AgentAbject');
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## ObjectAgent — General-Purpose Object Interaction Agent

### What I Handle
I interact with existing objects by discovering them and sending them messages.

Examples of tasks I handle well:
- Fetching data from APIs (weather, stocks, etc.)
- Running shell commands
- Reading/writing files
- Drawing on canvas apps, controlling UI objects, setting timers
- Any task that can be accomplished by sending messages to existing objects
- Multi-step workflows chaining messages across multiple objects

### My Scope
I work exclusively with objects that already exist in the system. I discover them, learn their capabilities, and orchestrate them via messages. Tasks that require generating new code, modifying an existing object's source code, browsing websites, or installed skill domains belong to other agents.

### When I answer YES

Whenever the task **names a specific object and asks me to call one of its existing methods** (e.g. "Call show() on the FooWidget", "Invoke refresh on DashboardApp", "Call getState on TelegramBridge", "Trigger a poll on TelegramBridge"), answer YES. A recent Registry scan may not list every freshly-created object, but the dispatcher gave me the object name directly, so I can discover it at execution time via \`find(name)\` or \`dep(name)\` and send the message. Do not answer NO just because the object did not appear in the Registry summary above — the object exists if the task names it.

Also say YES for:
- Fetching data from APIs or services through existing objects (HttpClient, capability objects, MCP-backed skills) — agents know their own configured credentials.
- Running shell commands via ShellExecutor.
- Reading/writing files via FileSystem or HostFileSystem.
- Drawing on canvas apps, controlling UI objects, toggling timers — anything accomplished by sending a message to a named object.
- Multi-step workflows that chain messages across multiple named objects.
- Debugging and investigation: reading Console logs, inspecting state via getState(), querying ProcessExplorer, asking HealthMonitor.

### How I Work
1. Ask the Registry which objects can help
2. Send ask messages to those objects to learn their capabilities
3. Send the right messages with the right parameters
4. Chain results across multiple objects if needed

When asked about a task, describe which objects you would message and what you would ask them to do.

### When I answer PASS
- Tasks that require creating, building, or making something new (apps, widgets, simulations, games, tools, agents) — those require generating new code.
- Tasks that require **modifying, fixing, editing, or patching the source code / handlers / methods of an existing object** ("fix the _pollTelegram method", "add a parse step to handleX", "change how show() renders", "patch the bug in Y"). I have no programmatic API to change source. AbjectEditor is a GUI and does not accept edits over messages. Editing an existing object's source is ObjectCreator's job via its \`modify\` method — defer to it.
- If a diagnosis finishes with "the fix is to change the code of object X", report the finding and stop; let the dispatcher route the follow-up fix task to a code-generation agent. Do not claim partial success by proposing a manual edit.`;
  }

  protected override async handleAsk(question: string): Promise<string> {
    // Extract task description from the confidence question
    const taskMatch = question.match(/Task:\s*"?(.+?)"?\s*$/m);
    const taskDesc = taskMatch?.[1] ?? question;

    // Ask Registry which objects can help with this task
    let registryContext = '';
    const regId = this.getRegistryId();
    if (regId) {
      try {
        registryContext = await this.request<string>(
          request(this.id, regId, 'ask', {
            question: `Which registered objects could help accomplish this task by sending them messages: "${taskDesc}"? List the most relevant objects with a brief description of how they help.`,
          }),
          15000,
        );
      } catch { /* Registry unavailable */ }
    }

    let prompt = this.askPrompt(question);
    if (registryContext) {
      prompt += '\n\n### Objects available to accomplish this task:\n' + registryContext;
    }

    return this.askLlm(prompt, question, 'fast');
  }

  private setupHandlers(): void {
    // ── TupleSpace dispatch handler ──
    this.on('executeTask', async (msg: AbjectMessage) => {
      const { tupleId, goalId, description, data, approach, failureHistory } = msg.payload as {
        tupleId: string; goalId?: string; description: string;
        data?: Record<string, unknown>; type: string; approach?: string;
        failureHistory?: Array<{ agent: string; error: string }>;
      };

      const taskId = `obj-exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.taskExtras.set(taskId, { taskData: data });
      this._currentGoalId = goalId;

      try {
        const systemPrompt = this.buildSystemPrompt(data);

        // Seed conversation with approach and failure context from previous attempts.
        const initialMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
        if (failureHistory && failureHistory.length > 0) {
          const failSummary = failureHistory
            .map(f => `- ${f.agent}: ${f.error}`)
            .join('\n');
          initialMessages.push(
            { role: 'user', content: `Task: ${description}\n\nPrevious attempts at this task failed:\n${failSummary}\n\nLearn from these failures and take a different approach.` },
          );
        } else if (approach) {
          initialMessages.push(
            { role: 'user', content: `Task: ${description}` },
          );
        }
        if (approach) {
          initialMessages.push(
            { role: 'assistant', content: `I will accomplish this as follows: ${approach}` },
          );
        }

        const { ticketId } = await this.request<{ ticketId: string }>(
          request(this.id, this.agentAbjectId!, 'startTask', {
            taskId,
            task: description,
            systemPrompt,
            goalId,
            dispatchTupleId: tupleId,
            initialMessages: initialMessages.length > 0 ? initialMessages : undefined,
            config: {
              maxSteps: 15,
              timeout: 300000,
              queueName: `object-agent-${taskId}`,
            },
          }),
        );
        const result = await this.waitForTaskResult(ticketId, 180000);
        return { success: result.success, result: result.result, error: result.error };
      } finally {
        this.taskExtras.delete(taskId);
        this._currentGoalId = undefined;
      }
    });

    // ── Direct runTask handler ──
    this.on('runTask', async (msg: AbjectMessage) => {
      const { task } = msg.payload as { task: string };
      const taskId = `obj-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.taskExtras.set(taskId, {});

      try {
        const systemPrompt = this.buildSystemPrompt();
        const { ticketId } = await this.request<{ ticketId: string }>(
          request(this.id, this.agentAbjectId!, 'startTask', {
            taskId,
            task,
            systemPrompt,
            config: {
              maxSteps: 15,
              timeout: 300000,
              queueName: `object-agent-${taskId}`,
            },
          }),
        );
        const result = await this.waitForTaskResult(ticketId, 180000);
        return { success: result.success, result: result.result };
      } finally {
        this.taskExtras.delete(taskId);
      }
    });

    // ── Ticket result handler ──
    this.on('taskResult', async (msg: AbjectMessage) => {
      const payload = msg.payload as { ticketId: string };
      const pending = this.pendingTickets.get(payload.ticketId);
      if (pending) {
        pending.resolve(payload);
      }
    });

    // Override progress handler: reset ticket timeouts and forward to GoalManager
    // so Chat's timeout resets during long operations (e.g. ObjectCreator.modify).
    // The base Abject handler only bubbles to _handlingRequestSenders which dies
    // at JobManager (no upstream during job execution).
    this.on('progress', (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts();
      if (this._currentGoalId && this.goalManagerId) {
        const payload = msg.payload as { phase?: string; message?: string } | undefined;
        this.send(event(this.id, this.goalManagerId, 'updateProgress', {
          goalId: this._currentGoalId,
          message: payload?.message ?? 'working...',
          phase: payload?.phase ?? 'acting',
          agentName: 'ObjectAgent',
        }));
      }
    });

    // ── AgentAbject callback handlers ──
    // Each callback proves the agent is still working, so reset the inactivity timeout.
    this.on('agentObserve', async (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts();
      const { taskId } = msg.payload as { taskId: string; step: number };
      return this.handleObserve(taskId);
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts();
      const { taskId, action } = msg.payload as { taskId: string; step: number; action: AgentAction };
      return this.handleAct(taskId, action);
    });

    this.on('agentPhaseChanged', async (msg: AbjectMessage) => {
      this.resetPendingTicketTimeouts();
      const { newPhase } = msg.payload as { taskId: string; step: number; oldPhase: string; newPhase: string };
      if (this.jobManagerId) {
        this.send(event(this.id, this.jobManagerId, 'progress', { phase: newPhase }));
      }
    });

    this.on('agentIntermediateAction', async () => { this.resetPendingTicketTimeouts(); });
    this.on('agentActionResult', async () => { this.resetPendingTicketTimeouts(); });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Registration
  // ═══════════════════════════════════════════════════════════════════

  private async registerWithAgentAbject(): Promise<void> {
    if (!this.agentAbjectId) return;

    await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'ObjectAgent',
      description:
        'Interacts with existing objects by discovering them and sending messages. ' +
        'Discovers objects via Registry, learns their capabilities via ask messages, then sends messages to accomplish tasks. ' +
        'Handles data fetching, object queries, and orchestrating existing objects at runtime. ' +
        'Best for runtime message passing over the bus. Object source authoring goes to a creation agent; interactive web browsing goes to a web-browsing agent; installed skill flows go to a skill-execution agent.',
      config: {
        terminalActions: {
          done: { type: 'success' as const, resultFields: ['result'] },
          fail: { type: 'error' as const, resultFields: ['reason'] },
        },
        intermediateActions: ['reply'],
        queueName: `object-agent-${this.id}`,
      },
    }));
  }

  // ═══════════════════════════════════════════════════════════════════
  // Observe / Act
  // ═══════════════════════════════════════════════════════════════════

  private async handleObserve(taskId: string): Promise<{ observation: string; llmContent?: ContentPart[] }> {
    const extra = this.taskExtras.get(taskId);
    const lines: string[] = [];

    if (extra?.lastResult) {
      lines.push(extra.lastResult);
    } else {
      lines.push('No previous action result.');
    }

    // Include task data hints if this is the first observation
    if (!extra?.lastResult && extra?.taskData) {
      const { object, method, payload } = extra.taskData as {
        object?: string; method?: string; payload?: unknown;
      };
      if (object) lines.push(`Hint: target object is "${object}"`);
      if (method) lines.push(`Hint: method to call is "${method}"`);
      if (payload !== undefined) lines.push(`Hint: payload is ${JSON.stringify(payload).slice(0, 500)}`);
    }

    const observation = lines.join('\n');

    // If the last action produced image content, include it for the LLM
    if (extra?.lastLlmContent) {
      const llmContent: ContentPart[] = [
        { type: 'text', text: observation },
        ...extra.lastLlmContent,
      ];
      extra.lastLlmContent = undefined;
      return { observation, llmContent };
    }

    return { observation };
  }

  private async handleAct(taskId: string, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const extra = this.taskExtras.get(taskId) ?? {};
    this.taskExtras.set(taskId, extra);

    try {
      let result: string;

      switch (action.action) {
        case 'ask': {
          const objectName = action.object as string;
          if (!objectName) return { success: false, error: 'ask action requires "object" field' };
          const question = action.question as string;
          if (!question) return { success: false, error: 'ask action requires "question" field' };

          const objectId = await this.resolveObject(objectName);
          if (!objectId) return { success: false, error: `Object "${objectName}" not found` };

          const answer = await this.request<string>(
            request(this.id, objectId, 'ask', { question }),
            60000,
          );
          result = typeof answer === 'string' ? answer : JSON.stringify(answer);
          break;
        }

        case 'introspect': {
          const objectName = action.object as string;
          if (!objectName) return { success: false, error: 'introspect action requires "object" field' };

          const objectId = await this.resolveObject(objectName);
          if (!objectId) return { success: false, error: `Object "${objectName}" not found` };

          const desc = await this.request<{ manifest: unknown; description: string }>(
            request(this.id, objectId, 'describe', {}),
          );
          result = desc.description;
          break;
        }

        case 'call': {
          const objectName = action.object as string;
          if (!objectName) return { success: false, error: 'call action requires "object" field' };
          const method = action.method as string;
          if (!method) return { success: false, error: 'call action requires "method" field' };

          const objectId = await this.resolveObject(objectName);
          if (!objectId) return { success: false, error: `Object "${objectName}" not found` };

          const timeout = (action.timeout as number) || 120000;
          const callResult = await this.request(
            request(this.id, objectId, method, action.payload ?? {}),
            timeout,
          );

          // Detect screenshot results and store image data for LLM vision
          if (callResult && typeof callResult === 'object' && 'imageBase64' in (callResult as Record<string, unknown>)) {
            const img = callResult as { imageBase64: string; width: number; height: number };
            if (img.imageBase64) {
              extra.lastLlmContent = [{
                type: 'image',
                mediaType: 'image/png',
                data: img.imageBase64,
              }];
              result = `Screenshot captured (${img.width}x${img.height}). The image is attached for your analysis.`;
              break;
            }
          }

          result = typeof callResult === 'string' ? callResult : JSON.stringify(callResult);
          break;
        }

        case 'write_scratchpad': {
          if (!this._currentGoalId) return { success: false, error: 'write_scratchpad requires an active goal context' };
          if (!this.goalManagerId) return { success: false, error: 'GoalManager not available' };
          const key = action.key as string;
          if (!key) return { success: false, error: 'write_scratchpad requires "key"' };
          await this.request(
            request(this.id, this.goalManagerId, 'writeGoalData', {
              goalId: this._currentGoalId, key, value: action.value,
            }),
          );
          result = `Wrote scratchpad key "${key}"`;
          break;
        }

        case 'read_scratchpad': {
          if (!this._currentGoalId) return { success: false, error: 'read_scratchpad requires an active goal context' };
          if (!this.goalManagerId) return { success: false, error: 'GoalManager not available' };
          const key = action.key as string | undefined;
          const value = await this.request(
            request(this.id, this.goalManagerId, 'readGoalData', {
              goalId: this._currentGoalId, ...(key ? { key } : {}),
            }),
          );
          result = typeof value === 'string' ? value : JSON.stringify(value);
          break;
        }

        default:
          return { success: false, error: `Unknown action: ${action.action}` };
      }

      extra.lastResult = result;
      return { success: true, data: result };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      extra.lastResult = `Error: ${errMsg}`;
      return { success: false, error: errMsg };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Object Resolution
  // ═══════════════════════════════════════════════════════════════════

  private async resolveObject(name: string): Promise<AbjectId | null> {
    const registryId = this.getRegistryId();
    if (!registryId || !name) return null;

    // UUIDs are direct AbjectIds
    if (name.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      return name as AbjectId;
    }

    // Resolve via Registry discover message
    try {
      const results = await this.request<Array<{ id: AbjectId }>>(
        request(this.id, registryId, 'discover', { name }),
      );
      return results.length > 0 ? results[0].id : null;
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // System Prompt
  // ═══════════════════════════════════════════════════════════════════

  private buildSystemPrompt(taskData?: Record<string, unknown>): string {
    let prompt = `You are ObjectAgent. You accomplish tasks by discovering and calling existing objects in the system.

## What You Do

You find objects via the Registry, learn their API via the ask protocol, and call their methods. You handle tasks like fetching data, running commands, controlling UI objects, reading files, and chaining multiple calls together.

## Interaction model

Every Abject in the system is remote and accessed through message passing. There are no local proxies, no imported libraries, no attached methods. Every single interaction — reads, writes, tool calls, config changes — is one message over the bus, addressed by AbjectId.

When you compose code (e.g. jobCode for JobManager or Scheduler, handler source for a new object), follow the canonical shape:

  const X_id = await dep('X');            // resolves to an AbjectId (a string)
  const result = await call(X_id, 'method', { ...params });

or, for optional lookups:

  const X_id = await find('X');           // may be undefined; check first

Reads and writes to Storage look like this:

  const storageId = await dep('Storage');
  const prev = await call(storageId, 'get', { key: 'my-key' });
  await call(storageId, 'set', { key: 'my-key', value: { hits: (prev?.hits ?? 0) + 1 } });

The id returned by dep/find is a plain string. Method names live on the receiver, so the pattern is always \`const id = await dep('Name'); await call(id, 'method', { ...params })\`. Ask the target object directly (via the **ask** action) when you need its specific method signatures.

## Hand off to another agent when

- The task requires creating a new object or app from scratch (hand off via **decompose** with role hints)
- The task requires modifying or rewriting an existing object's source code
- The task requires visiting URLs, navigating a website, or multi-page research
- The task requires running an installed skill's natural-language flow

For everything else that is fetch-data / run-a-tool / read-or-write-some-state work, stay with it yourself.

## Workflow

1. **Ask the Registry** which objects can help with your task
2. **Ask the target object** how to use its API
3. **Call** the object with the right method and payload
4. Chain results from one call into the next if needed

## Output Format

Respond with ONE JSON object inside \`\`\`json fenced code markers. Include brief reasoning before the block.

\`\`\`json
{ "action": "ask", "object": "Registry", "question": "Which objects can help me fetch weather data?", "reasoning": "Need to find the right object" }
\`\`\`

## Available Actions

| Action | Fields | Description |
|--------|--------|-------------|
| ask | object, question | Ask an object a question via the ask protocol. |
| introspect | object | Get an object's manifest and method descriptions. |
| call | object, method, payload?, timeout? | Call a method on an object. |
| write_scratchpad | key, value | Write a value to the goal's shared scratchpad under the given key. Use this to fulfil a contract's produces keys (see "Your Task's Contract" in the injected context) so downstream tasks can read structured findings. |
| read_scratchpad | key? | Read a value from the goal's scratchpad. Omit key to read the full scratchpad. Values for keys in your task's consumes list are already shown in the injected context; use this action only when you need to fetch something extra. |
| decompose | subtasks | Break the task into sub-tasks for other agents. Each subtask has a description and optional data. |
| done | result | Task complete. Include the full answer. |
| fail | reason | Task cannot be completed. |
| reply | message | Send a progress update. |
`;

    if (taskData) {
      const { object, method, payload } = taskData as {
        object?: string; method?: string; payload?: unknown;
      };
      if (object || method) {
        prompt += '\n## Task Hints\n\n';
        if (object) prompt += `Target object: ${object}\n`;
        if (method) prompt += `Method to call: ${method}\n`;
        if (payload !== undefined) prompt += `Payload: ${JSON.stringify(payload).slice(0, 500)}\n`;
        prompt += '\nYou may use these hints to skip discovery and call directly, or use "ask" to verify the API first.\n';
      }
    }

    return prompt;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Ticket waiting (same pattern as SkillAgent/WebAgent)
  // ═══════════════════════════════════════════════════════════════════

  private pendingTickets = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    timeoutMs: number;
  }>();

  /** Reset all pending ticket timeouts on progress (agent is still working). */
  private resetPendingTicketTimeouts(): void {
    for (const [ticketId, entry] of this.pendingTickets) {
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => {
        this.pendingTickets.delete(ticketId);
        if (this.agentAbjectId) {
          this.send(
            request(this.id, this.agentAbjectId, 'cancelTask', { taskId: ticketId })
          );
        }
        entry.reject(new Error(`Task ${ticketId} timed out after ${entry.timeoutMs}ms of inactivity`));
      }, entry.timeoutMs);
    }
  }

  private waitForTaskResult(ticketId: string, timeout: number): Promise<{ success: boolean; result?: unknown; error?: string }> {
    return new Promise((resolve, reject) => {
      const makeTimer = () => setTimeout(() => {
        this.pendingTickets.delete(ticketId);
        if (this.agentAbjectId) {
          this.send(
            request(this.id, this.agentAbjectId, 'cancelTask', { taskId: ticketId })
          );
        }
        reject(new Error(`Task ${ticketId} timed out after ${timeout}ms of inactivity`));
      }, timeout);

      const entry = {
        timer: makeTimer(),
        timeoutMs: timeout,
        resolve: (payload: unknown) => {
          clearTimeout(entry.timer);
          this.pendingTickets.delete(ticketId);
          const p = payload as { success?: boolean; result?: unknown; error?: string; state?: { result?: unknown; error?: string } };
          const success = p.success !== false && !p.error;
          resolve({
            success,
            result: p.result ?? p.state?.result,
            error: p.error ?? p.state?.error,
          });
        },
        reject: (err: Error) => {
          clearTimeout(entry.timer);
          this.pendingTickets.delete(ticketId);
          reject(err);
        },
      };
      this.pendingTickets.set(ticketId, entry);
    });
  }
}

export const OBJECT_AGENT_ID = 'abjects:object-agent' as AbjectId;
