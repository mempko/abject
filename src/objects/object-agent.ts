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

### What I Do NOT Handle
- Creating brand-new objects from scratch
- Browsing websites or navigating web pages
- Tasks specific to an installed skill's domain

### How I Work
1. Ask the Registry which objects can help
2. Send ask messages to those objects to learn their capabilities
3. Send the right messages with the right parameters
4. Chain results across multiple objects if needed

When asked about a task, describe which objects you would message and what you would ask them to do.
Say CANNOT if the task involves creating, building, or making something new (apps, widgets, simulations, games, tools, agents). I can only interact with objects that already exist, not generate new code or spawn new objects.`;
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
      const { goalId, description, data, approach } = msg.payload as {
        tupleId: string; goalId?: string; description: string;
        data?: Record<string, unknown>; type: string; approach?: string;
      };

      const taskId = `obj-exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.taskExtras.set(taskId, { taskData: data });

      try {
        const systemPrompt = this.buildSystemPrompt(data);

        // If the dispatch included the agent's proposed approach, seed it as
        // an initial message so the agent skips re-discovery and acts on its plan.
        const initialMessages = approach
          ? [
              { role: 'user' as const, content: `Task: ${description}` },
              { role: 'assistant' as const, content: `I will accomplish this as follows: ${approach}` },
            ]
          : undefined;

        const { ticketId } = await this.request<{ ticketId: string }>(
          request(this.id, this.agentAbjectId!, 'startTask', {
            taskId,
            task: description,
            systemPrompt,
            goalId,
            initialMessages,
            config: {
              maxSteps: 15,
              timeout: 300000,
              queueName: `object-agent-${taskId}`,
            },
          }),
        );
        const result = await this.waitForTaskResult(ticketId, 310000);
        return { success: result.success, result: result.result, error: result.error };
      } finally {
        this.taskExtras.delete(taskId);
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
        const result = await this.waitForTaskResult(ticketId, 310000);
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
        this.pendingTickets.delete(payload.ticketId);
        pending.resolve(payload);
      }
    });

    // ── AgentAbject callback handlers ──
    this.on('agentObserve', async (msg: AbjectMessage) => {
      const { taskId } = msg.payload as { taskId: string; step: number };
      return this.handleObserve(taskId);
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      const { taskId, action } = msg.payload as { taskId: string; step: number; action: AgentAction };
      return this.handleAct(taskId, action);
    });

    this.on('agentPhaseChanged', async (msg: AbjectMessage) => {
      const { newPhase } = msg.payload as { taskId: string; step: number; oldPhase: string; newPhase: string };
      if (this.jobManagerId) {
        this.send(event(this.id, this.jobManagerId, 'progress', { phase: newPhase }));
      }
    });

    this.on('agentIntermediateAction', async () => { /* handled by AgentAbject */ });
    this.on('agentActionResult', async () => { /* handled by AgentAbject */ });
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
        'Handles data fetching, object queries, and orchestrating existing objects.',
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

## What You Do NOT Do

You do not create new objects, modify object source code, browse websites, or run installed skills. If the task requires any of these, use **decompose** immediately to hand it off to a specialized agent.

Decompose when the task involves:
- Creating a new object or app from scratch
- Modifying or rewriting an existing object's behavior/source code
- Visiting a URL or navigating a website
- Research that requires browsing multiple web pages

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

  private pendingTickets = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private waitForTaskResult(ticketId: string, timeout: number): Promise<{ success: boolean; result?: unknown; error?: string }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTickets.delete(ticketId);
        reject(new Error(`Task ${ticketId} timed out after ${timeout}ms`));
      }, timeout);

      this.pendingTickets.set(ticketId, {
        resolve: (payload: unknown) => {
          clearTimeout(timer);
          const p = payload as { success?: boolean; result?: unknown; error?: string; state?: { result?: unknown; error?: string } };
          const success = p.success !== false && !p.error;
          resolve({
            success,
            result: p.result ?? p.state?.result,
            error: p.error ?? p.state?.error,
          });
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
  }
}

export const OBJECT_AGENT_ID = 'abjects:object-agent' as AbjectId;
