/**
 * WebAgent — autonomous browser agent.
 *
 * Registers with AgentAbject as an agent. AgentAbject drives the
 * think-act-observe state machine, calling back WebAgent for domain-specific
 * observe (page scraping + screenshot) and act (browser interactions).
 */

import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { require as contractRequire } from '../core/contracts.js';
import type { AgentAction } from './agent-abject.js';
import type { ContentPart } from '../llm/provider.js';
import { Log } from '../core/timed-log.js';

const log = new Log('WebAgent');

const WEB_AGENT_INTERFACE: InterfaceId = 'abjects:web-agent';

interface WebTaskOptions {
  maxSteps?: number;
  startUrl?: string;
  timeout?: number;
  pageOptions?: { userAgent?: string; viewport?: { width: number; height: number } };
  responseSchema?: Record<string, unknown>;
  pageId?: string;         // reuse an existing open page
  keepPageOpen?: boolean;  // don't close page after task completes
}

/** Per-task extra state (page IDs, startUrl, screenshots). */
interface WebTaskExtra {
  startUrl?: string;
  pageId?: string;
  pageOptions?: { userAgent?: string; viewport?: { width: number; height: number } };
  responseSchema?: Record<string, unknown>;
  lastScreenshot?: string;  // raw base64 (no data URI prefix)
  keepPageOpen?: boolean;          // don't close page after task completes
  pageOpenedByThisTask?: boolean;  // tracks if WE opened it (for cleanup on error)
}

// ─── WebAgent ───────────────────────────────────────────────────────

export class WebAgent extends Abject {
  private webBrowserId?: AbjectId;
  private consoleId?: AbjectId;
  private agentAbjectId?: AbjectId;
  private jobManagerId?: AbjectId;
  private goalManagerId?: AbjectId;

  /** Per-task extra state (page IDs, startUrl, etc.). */
  private taskExtras = new Map<string, WebTaskExtra>();

  /** Kept-open pages: pageId → idle timeout handle. */
  private keptOpenPages = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly PAGE_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

  /** Pending ticket promises: ticketId → resolve/reject. */
  private pendingTickets = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor() {
    super({
      manifest: {
        name: 'WebAgent',
        description:
          'Autonomous web browsing agent. Give it a task description and it handles navigation, content extraction, form filling, screenshots, and error recovery automatically. Accepts natural language goals via runTask.',
        version: '1.0.0',
        interface: {
          id: WEB_AGENT_INTERFACE,
          name: 'WebAgent',
          description: 'Autonomous web browser agent',
          methods: [
            {
              name: 'runTask',
              description: 'Run a full autonomous web task. Returns when complete. Default maxSteps is 15. When the step limit is reached, the agent makes one final attempt to return whatever data it has collected, then errors if nothing was gathered. For complex tasks requiring pagination or many interactions, pass a higher maxSteps (e.g. 30-50).',
              parameters: [
                { name: 'task', type: { kind: 'primitive', primitive: 'string' }, description: 'Natural language task description' },
                {
                  name: 'options', type: { kind: 'object', properties: {
                    maxSteps: { kind: 'primitive', primitive: 'number' },
                    startUrl: { kind: 'primitive', primitive: 'string' },
                    timeout: { kind: 'primitive', primitive: 'number' },
                    responseSchema: { kind: 'object', properties: {} },
                    pageId: { kind: 'primitive', primitive: 'string' },
                    keepPageOpen: { kind: 'primitive', primitive: 'boolean' },
                  }}, description: 'Task options. maxSteps defaults to 15; increase for multi-page or paginated tasks.', optional: true,
                },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                result: { kind: 'primitive', primitive: 'string' },
                steps: { kind: 'primitive', primitive: 'number' },
                validationErrors: { kind: 'array', elementType: { kind: 'primitive', primitive: 'string' } },
                pageId: { kind: 'primitive', primitive: 'string' },
              }},
            },
            {
              name: 'runStep',
              description: 'Run a single LLM-planned step on an already-open page',
              parameters: [
                { name: 'pageId', type: { kind: 'primitive', primitive: 'string' }, description: 'Open page ID' },
                { name: 'instruction', type: { kind: 'primitive', primitive: 'string' }, description: 'What to do' },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                result: { kind: 'primitive', primitive: 'string' },
              }},
            },
            {
              name: 'closePage',
              description: 'Manually close a kept-open page',
              parameters: [
                { name: 'pageId', type: { kind: 'primitive', primitive: 'string' }, description: 'Page ID to close' },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
              }},
            },
            {
              name: 'getTaskStatus',
              description: 'Get status of a running or completed task',
              parameters: [
                { name: 'taskId', type: { kind: 'primitive', primitive: 'string' }, description: 'Task ID' },
              ],
              returns: { kind: 'object', properties: {
                phase: { kind: 'primitive', primitive: 'string' },
                step: { kind: 'primitive', primitive: 'number' },
                error: { kind: 'primitive', primitive: 'string' },
              }},
            },
            {
              name: 'listPages',
              description: 'List kept-open pages available for reuse',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'object', properties: {
                pageId: { kind: 'primitive', primitive: 'string' },
                url: { kind: 'primitive', primitive: 'string' },
                title: { kind: 'primitive', primitive: 'string' },
              }}},
            },
            {
              name: 'executeTask',
              description: 'Execute a task dispatched by AgentAbject (browse, research, or web)',
              parameters: [
                { name: 'tupleId', type: { kind: 'primitive', primitive: 'string' }, description: 'TupleSpace tuple ID' },
                { name: 'goalId', type: { kind: 'primitive', primitive: 'string' }, description: 'Goal ID', optional: true },
                { name: 'description', type: { kind: 'primitive', primitive: 'string' }, description: 'Task description' },
                { name: 'type', type: { kind: 'primitive', primitive: 'string' }, description: 'Task type (browse, research, web)' },
                { name: 'data', type: { kind: 'object', properties: {} }, description: 'Task-specific data', optional: true },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                result: { kind: 'primitive', primitive: 'string' },
                error: { kind: 'primitive', primitive: 'string' },
              }},
            },
            {
              name: 'listTasks',
              description: 'List all tasks, newest first',
              parameters: [],
              returns: { kind: 'array', elementType: { kind: 'object', properties: {
                id: { kind: 'primitive', primitive: 'string' },
                phase: { kind: 'primitive', primitive: 'string' },
                task: { kind: 'primitive', primitive: 'string' },
                step: { kind: 'primitive', primitive: 'number' },
              }}},
            },
          ],
          events: [
            {
              name: 'taskProgress',
              description: 'Emitted after each phase transition',
              payload: { kind: 'object', properties: {
                taskId: { kind: 'primitive', primitive: 'string' },
                step: { kind: 'primitive', primitive: 'number' },
                phase: { kind: 'primitive', primitive: 'string' },
                action: { kind: 'primitive', primitive: 'string' },
                url: { kind: 'primitive', primitive: 'string' },
              }},
            },
          ],
        },
        requiredCapabilities: [
          { capability: Capabilities.WEB_BROWSE, reason: 'Control browser pages', required: true },
          { capability: Capabilities.LLM_QUERY, reason: 'LLM planning', required: true },
        ],
        providedCapabilities: [Capabilities.WEB_AGENT],
        tags: ['system', 'agent', 'web', 'automation'],
      },
    });

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## WebAgent — Autonomous Web Browsing Agent

### What I Handle
I am the agent for tasks that require a REAL WEB BROWSER with interactive navigation.
I open a headless browser, navigate to URLs, and use an LLM-driven loop to complete web tasks.

Examples of tasks I handle well:
- Filling out forms, clicking buttons, navigating multi-page workflows
- Logging into websites (social media, email, web apps)
- Scraping data from JavaScript-rendered pages that require JS execution
- Taking screenshots of web pages
- Searching the web via a search engine
- Any task that requires interactive browser navigation (clicks, scrolls, form fills)

### What I Do NOT Handle
- Simple HTTP data fetches (use HttpClient instead, not a browser)
- Fetching weather, API data, or RSS feeds (these are simple GET requests, not browser tasks)
- Calling internal system APIs or objects directly
- Creating new objects from scratch
- Tasks that don't involve interactive web pages

When asked about a task, describe your browsing approach if it genuinely needs an interactive browser. Say CANNOT for simple data fetching (weather APIs, RSS feeds, JSON endpoints) since those are better handled by HttpClient.

### Run a Full Web Task (free-text result)

  const result = await call(await dep('WebAgent'), 'runTask', {
    task: 'Search for "abjects" on Google and return the first result',
    options: { startUrl: 'https://www.google.com', maxSteps: 15, timeout: 120000 },
  }, { timeout: 300000 });  // long-running — extend the default 30s call timeout
  // result: { success, result, steps, error?, maxStepsReached? }

### Run a Web Task with Structured Result

  const result = await call(await dep('WebAgent'), 'runTask', {
    task: 'Extract the top 5 stories from the front page',
    options: {
      startUrl: 'https://news.ycombinator.com',
      maxSteps: 10,
      responseSchema: {
        type: 'object',
        properties: {
          stories: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' },
                url: { type: 'string' },
                points: { type: 'number' },
              },
              required: ['title', 'url'],
            },
          },
        },
        required: ['stories'],
      },
    },
  }, { timeout: 300000 });  // long-running — extend the default 30s call timeout
  // result: { success, result: { stories: [...] }, steps, validationErrors?, maxStepsReached? }

Use responseSchema (JSON Schema format) when you need structured data back.
Without it, the result is free text. validationErrors is undefined on success.

### Run a Single Step on an Open Page

  const result = await call(await dep('WebAgent'), 'runStep', {
    pageId: 'existing-page-id',
    instruction: 'Click the login button',
  });
  // result: { success, result, error? }

### Get Task Status

  const status = await call(await dep('WebAgent'), 'getTaskStatus', {
    taskId: 'web-task-id',
  });
  // status: { phase, step, error? }

### List All Tasks

  const tasks = await call(await dep('WebAgent'), 'listTasks', {});
  // tasks: [{ id, phase, task, step }]

### Multi-Step Workflow (page reuse)

Pages are kept open by default after task completion (with a 5-minute idle timeout).
Pass the returned pageId to subsequent runTask calls to reuse the same page.
Set keepPageOpen: false to explicitly close the page when done.

  // Step 1: Login — page stays open by default
  const result = await call(await dep('WebAgent'), 'runTask', {
    task: 'Go to site and log in with user/pass',
    options: { startUrl: 'https://example.com/login' },
  });
  // result.pageId is available for reuse

  // Step 2: 2FA — reuse same page
  const result2 = await call(await dep('WebAgent'), 'runTask', {
    task: 'Enter 2FA code 123456 and submit',
    options: { pageId: result.pageId },
  });

  // Step 3: Final action — explicitly close the page
  const result3 = await call(await dep('WebAgent'), 'runTask', {
    task: 'Extract dashboard data',
    options: { pageId: result2.pageId, keepPageOpen: false },
  });

### List Kept-Open Pages

  const pages = await call(await dep('WebAgent'), 'listPages', {});
  // pages: [{ pageId, url, title }]

### Close a Kept-Open Page Manually

  await call(await dep('WebAgent'), 'closePage', { pageId: 'page-id' });

### Step Limits
- **maxSteps defaults to 15.** Each observe-think-act cycle counts as one step.
- When the limit is reached, the agent makes one final LLM call to return whatever data it has, then errors if nothing was gathered.
- For complex tasks (pagination, multi-step forms, scraping many items), pass a higher maxSteps: 30-50.
- The result includes \`maxStepsReached: true\` when the limit was hit.

### IMPORTANT
- The method is **runTask** (not "run" or "navigate").
- Options: startUrl, maxSteps, timeout, pageOptions, responseSchema, pageId, keepPageOpen.
- Pages stay open by default after task completion (5-minute idle timeout). Pass keepPageOpen: false to close immediately.
- WebAgent manages browser pages — do NOT call WebBrowser directly.
- **runTask is long-running** — always pass \`{ timeout: 300000 }\` as the 4th argument to \`call()\` (the default 30s timeout is too short).
- Kept-open pages auto-close after 5 minutes of inactivity.
- Internally, WebAgent uses a ticket pattern with AgentAbject — startTask returns a ticketId and results arrive via taskResult events.
- WebAgent can receive tasks via LLM semantic fallback even for task types it doesn't explicitly declare.`;
  }

  protected override async handleAsk(question: string): Promise<string> {
    return this.askLlm(this.askPrompt(question), question, 'fast');
  }

  protected override async onInit(): Promise<void> {
    this.webBrowserId = await this.requireDep('WebBrowser');
    this.consoleId = await this.discoverDep('Console') ?? undefined;
    this.agentAbjectId = await this.requireDep('AgentAbject');
    this.jobManagerId = await this.discoverDep('JobManager') ?? undefined;
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;

    // Register with AgentAbject
    await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'WebAgent',
      description: 'Browses real websites using a headless browser. Handles web scraping, visiting URLs, navigating websites, reading page content, filling forms, taking screenshots, extracting data, and researching topics on the web. Only use for tasks involving real external websites.',
      config: {
        terminalActions: {
          done: { type: 'success', resultFields: ['result'] },
          fail: { type: 'error', resultFields: ['reason'] },
        },
        queueName: `web-agent-${this.id}`,
      },
    }));
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

    this.on('runTask', async (msg: AbjectMessage) => {
      const { task, options } = msg.payload as { task: string; options?: WebTaskOptions };
      contractRequire(typeof task === 'string' && task.trim().length > 0, 'task must be a non-empty string');

      const taskId = `web-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      log.info(`► runTask (${taskId}): "${task.trim().slice(0, 80)}"`);

      const extra: WebTaskExtra = {
        startUrl: options?.startUrl,
        pageId: options?.pageId,
        pageOptions: options?.pageOptions,
        responseSchema: options?.responseSchema,
        keepPageOpen: options?.keepPageOpen ?? true,
      };
      this.taskExtras.set(taskId, extra);

      // If reusing a kept-open page, clear its idle timeout
      if (options?.pageId) {
        this.untrackKeptOpenPage(options.pageId);
      }

      // Fire-and-forget: run task asynchronously via AgentAbject
      this.runTaskAsync(msg, taskId, task.trim(), extra, options);
      // Return deferred — we still reply to the original caller via sendDeferredReply
      return DEFERRED_REPLY;
    });

    this.on('runStep', async (msg: AbjectMessage) => {
      const { pageId, instruction } = msg.payload as { pageId: string; instruction: string };
      contractRequire(typeof pageId === 'string', 'pageId required');
      contractRequire(typeof instruction === 'string', 'instruction required');

      const taskId = `web-step-${Date.now()}`;
      this.taskExtras.set(taskId, { pageId });

      // For single steps, use directExecution to avoid queue deadlocks
      const { ticketId } = await this.request<{ ticketId: string }>(
        request(this.id, this.agentAbjectId!, 'startTask', {
          taskId,
          task: instruction,
          systemPrompt: this.buildSystemPrompt(instruction),
          config: {
            maxSteps: 3,
            timeout: 120000,
            directExecution: true,
            queueName: `web-agent-${this.id}`,
          },
        }),
      );
      const result = await this.waitForTaskResult(ticketId, 130000);

      return { success: result.success, result: result.result, error: result.error };
    });

    this.on('closePage', async (msg: AbjectMessage) => {
      const { pageId } = msg.payload as { pageId: string };
      contractRequire(typeof pageId === 'string' && pageId.length > 0, 'pageId required');
      this.untrackKeptOpenPage(pageId);
      await this.request(
        request(this.id, this.webBrowserId!, 'closePage', { pageId })
      );
      return { success: true };
    });

    this.on('listPages', async (msg: AbjectMessage) => {
      // Query WebBrowser for all pages, then filter to our kept-open set
      const allPages = await this.request<Array<{ pageId: string; url: string; title: string }>>(
        request(this.id, this.webBrowserId!, 'listPages', {})
      );
      const keptIds = new Set(this.keptOpenPages.keys());
      return allPages.filter(p => keptIds.has(p.pageId));
    });

    this.on('getTaskStatus', async (msg: AbjectMessage) => {
      const { taskId } = msg.payload as { taskId: string };
      // Forward to AgentAbject
      return this.request(request(this.id, this.agentAbjectId!, 'getTaskStatus', { taskId }));
    });

    this.on('listTasks', async () => {
      // Forward to AgentAbject, filtered by our agentId
      return this.request(request(this.id, this.agentAbjectId!, 'listTasks', { agentId: this.id }));
    });

    this.on('executeTask', async (msg: AbjectMessage) => {
      const { goalId, description, data } = msg.payload as {
        tupleId: string; goalId?: string; description: string;
        data?: Record<string, unknown>; type: string;
      };

      const taskId = `web-exec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const startUrl = data?.startUrl as string | undefined;

      const extra: WebTaskExtra = { startUrl };
      this.taskExtras.set(taskId, extra);

      // Open page
      const pageResult = await this.request<{ pageId: string }>(
        request(this.id, this.webBrowserId!, 'openPage', {})
      );
      extra.pageId = pageResult.pageId;
      extra.pageOpenedByThisTask = true;

      if (startUrl) {
        await this.request(
          request(this.id, this.webBrowserId!, 'navigateTo', { pageId: extra.pageId, url: startUrl })
        );
      }

      try {
        // Run task via AgentAbject
        const { ticketId } = await this.request<{ ticketId: string }>(
          request(this.id, this.agentAbjectId!, 'startTask', {
            taskId,
            task: description,
            systemPrompt: this.buildSystemPrompt(description),
            goalId,
            config: {
              maxSteps: 15,
              timeout: 300000,
              queueName: `web-agent-${taskId}`,
            },
          }),
        );
        const ticketResult = await this.waitForTaskResult(ticketId, 310000);

        // Respect the LLM's keepPageOpen signal; default to closing
        const agentWantsOpen = ticketResult.lastAction?.keepPageOpen === true;
        if (agentWantsOpen && extra.pageId) {
          this.trackKeptOpenPage(extra.pageId);
        } else if (extra.pageId) {
          try {
            await this.request(request(this.id, this.webBrowserId!, 'closePage', { pageId: extra.pageId }));
          } catch { /* best effort */ }
        }

        return { success: ticketResult.success, result: ticketResult.result, error: ticketResult.error };
      } catch (err) {
        // On failure, keep page open for inspection if we opened it
        if (extra.pageId) {
          this.trackKeptOpenPage(extra.pageId);
        }
        throw err; // Re-throw so AgentAbject's dispatchToAgent records the failure
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
      const { taskId, step, newPhase, action } =
        msg.payload as { taskId: string; step: number; oldPhase: string; newPhase: string; action?: string };

      // Emit taskProgress for dependents
      this.changed('taskProgress', { taskId, step, phase: newPhase, action });

      // Forward progress to JobManager to keep the outer call alive
      if (this.jobManagerId) {
        this.send(event(this.id, this.jobManagerId, 'progress', { phase: newPhase }));
      }
    });

    this.on('agentIntermediateAction', async () => { /* no-op for WebAgent */ });
    this.on('agentActionResult', async () => { /* no-op for WebAgent */ });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Kept-open page tracking
  // ═══════════════════════════════════════════════════════════════════

  /** Start an idle timeout for a kept-open page; auto-closes when it expires. */
  private trackKeptOpenPage(pageId: string): void {
    this.untrackKeptOpenPage(pageId);
    const handle = setTimeout(async () => {
      log.info(`Idle timeout expired for page ${pageId}, closing`);
      this.keptOpenPages.delete(pageId);
      try {
        await this.request(
          request(this.id, this.webBrowserId!, 'closePage', { pageId })
        );
      } catch { /* best effort */ }
    }, WebAgent.PAGE_IDLE_TIMEOUT_MS);
    this.keptOpenPages.set(pageId, handle);
  }

  /** Clear the idle timeout for a page (called when the page is reused). */
  private untrackKeptOpenPage(pageId: string): void {
    const existing = this.keptOpenPages.get(pageId);
    if (existing) {
      clearTimeout(existing);
      this.keptOpenPages.delete(pageId);
    }
  }

  protected override async onStop(): Promise<void> {
    for (const timeout of this.keptOpenPages.values()) clearTimeout(timeout);
    this.keptOpenPages.clear();
    // Reject any pending tickets
    for (const [id, pending] of this.pendingTickets) {
      pending.reject(new Error('WebAgent stopped'));
    }
    this.pendingTickets.clear();
  }

  private waitForTaskResult(ticketId: string, timeoutMs: number): Promise<{
    ticketId: string; success: boolean; result?: unknown; error?: string;
    steps: number; maxStepsReached?: boolean; validationErrors?: string[];
    lastAction?: Record<string, unknown>;
  }> {
    type TaskResult = { ticketId: string; success: boolean; result?: unknown; error?: string; steps: number; maxStepsReached?: boolean; validationErrors?: string[]; lastAction?: Record<string, unknown> };
    return new Promise<TaskResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingTickets.delete(ticketId);
        reject(new Error(`Task ${ticketId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingTickets.set(ticketId, {
        resolve: (v) => { clearTimeout(timer); resolve(v as TaskResult); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Async task runner (fire-and-forget from runTask handler)
  // ═══════════════════════════════════════════════════════════════════

  private async runTaskAsync(
    originalMsg: AbjectMessage,
    taskId: string,
    taskText: string,
    extra: WebTaskExtra,
    options?: WebTaskOptions,
  ): Promise<void> {
    let result: { success: boolean; result?: unknown; error?: string; steps: number; maxStepsReached?: boolean };

    try {
      // Open page (or reuse an existing kept-open page)
      if (!extra.pageId) {
        log.info(`Opening page (${taskId})`);
        const pageResult = await this.request<{ pageId: string }>(
          request(this.id, this.webBrowserId!, 'openPage', {
            options: extra.pageOptions,
          })
        );
        extra.pageId = pageResult.pageId;
        extra.pageOpenedByThisTask = true;

        if (extra.startUrl) {
          log.info(`Navigating to ${extra.startUrl}`);
          await this.request(
            request(this.id, this.webBrowserId!, 'navigateTo', {
              pageId: extra.pageId,
              url: extra.startUrl,
            })
          );
        }
      } else {
        log.info(`Reusing existing page ${extra.pageId} (${taskId})`);
      }

      // Run task via AgentAbject — submit ticket + await result event.
      // Each task gets its own queue so concurrent runTask calls can execute in parallel.
      const taskTimeout = (options?.timeout ?? 300000) + 10000;
      const { ticketId } = await this.request<{ ticketId: string }>(
        request(this.id, this.agentAbjectId!, 'startTask', {
          taskId,
          task: taskText,
          systemPrompt: this.buildSystemPrompt(taskText, options?.maxSteps),
          responseSchema: extra.responseSchema,
          config: {
            maxSteps: options?.maxSteps,
            timeout: options?.timeout,
            queueName: `web-agent-${taskId}`,
          },
        }),
      );
      const ticketResult = await this.waitForTaskResult(ticketId, taskTimeout);
      result = { success: ticketResult.success, result: ticketResult.result, error: ticketResult.error, steps: ticketResult.steps, maxStepsReached: ticketResult.maxStepsReached };

      // Let the LLM's done action override the caller's keepPageOpen preference
      if (ticketResult.lastAction?.keepPageOpen !== undefined) {
        extra.keepPageOpen = Boolean(ticketResult.lastAction.keepPageOpen);
      }
    } catch (err) {
      result = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        steps: 0,
      };
    }

    // Page cleanup — after try/catch so `result` is guaranteed assigned
    if (extra.keepPageOpen && result.success && extra.pageId) {
      // Keep the page open for the caller to reuse; start idle timeout
      log.info(`Keeping page ${extra.pageId} open for reuse`);
      this.trackKeptOpenPage(extra.pageId);
    } else if (!result.success && !extra.pageOpenedByThisTask && extra.pageId) {
      // Task failed on a pre-existing page — leave it for caller to retry/inspect
      log.info(`Task failed on pre-existing page ${extra.pageId}, leaving open`);
      this.trackKeptOpenPage(extra.pageId);
    } else if (extra.pageId) {
      // Close the page
      log.info(`Closing page ${extra.pageId}`);
      try {
        await this.request(
          request(this.id, this.webBrowserId!, 'closePage', { pageId: extra.pageId })
        );
      } catch { /* best effort */ }
    }

    if (result.success) {
      log.info(`Task complete (${taskId}) in ${result.steps} steps`);
    }

    // Include pageId when the page is kept open for reuse
    const replyPageId = (extra.keepPageOpen && result.success && extra.pageId)
      || (!result.success && !extra.pageOpenedByThisTask && extra.pageId)
      ? extra.pageId : undefined;

    try {
      this.sendDeferredReply(originalMsg, {
        success: result.success,
        result: result.result,
        error: result.error,
        steps: result.steps,
        ...(result.maxStepsReached ? { maxStepsReached: true } : {}),
        ...(replyPageId ? { pageId: replyPageId } : {}),
      });
    } catch { /* caller may be gone */ }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Observe callback — page scraping + screenshot
  // ═══════════════════════════════════════════════════════════════════

  private static readonly MAX_SNAPSHOT_CHARS = 25000;

  private static readonly FAST_TIER_REF_THRESHOLD = 30;
  private static readonly FAST_TIER_CHAR_THRESHOLD = 8000;

  private async handleObserve(taskId: string): Promise<{ observation: string; llmContent?: ContentPart[]; tier?: string }> {
    const extra = this.taskExtras.get(taskId);
    if (!extra?.pageId) return { observation: 'No page open.' };

    try {
      // Get ARIA snapshot (includes URL, title, and ref-annotated accessibility tree)
      const { snapshot, url, title } = await this.request<{ snapshot: string; url: string; title: string }>(
        request(this.id, this.webBrowserId!, 'getAriaSnapshot', { pageId: extra.pageId })
      );

      const refCount = (snapshot.match(/\[ref=e\d+\]/g) || []).length;

      // Pick LLM tier based on page complexity
      const tier = (refCount <= WebAgent.FAST_TIER_REF_THRESHOLD && snapshot.length <= WebAgent.FAST_TIER_CHAR_THRESHOLD)
        ? 'fast' : 'balanced';
      log.info(`Observe: URL=${url} | ${refCount} elements (ARIA snapshot, ${snapshot.length} chars) tier=${tier}`);

      // Truncate very large snapshots to stay within token budget
      let truncatedSnapshot = snapshot;
      if (snapshot.length > WebAgent.MAX_SNAPSHOT_CHARS) {
        truncatedSnapshot = snapshot.slice(0, WebAgent.MAX_SNAPSHOT_CHARS) + '\n... (snapshot truncated)';
      }

      const lines: string[] = [];
      lines.push(`URL: ${url}`);
      lines.push(`Title: ${title}`);
      lines.push('');
      lines.push('Page structure (ARIA snapshot):');
      lines.push(truncatedSnapshot);

      const observation = lines.join('\n');

      // Take screenshot for vision-enabled LLM observation
      try {
        const shot = await this.request<{ dataUri: string }>(
          request(this.id, this.webBrowserId!, 'screenshotPage', { pageId: extra.pageId })
        );
        extra.lastScreenshot = shot.dataUri.replace(/^data:image\/\w+;base64,/, '');
      } catch { extra.lastScreenshot = undefined; }

      // Return with llmContent for vision support
      if (extra.lastScreenshot) {
        return {
          observation,
          tier,
          llmContent: [
            { type: 'text' as const, text: `[Observation - Step]\n${observation}` },
            { type: 'image' as const, mediaType: 'image/png' as const, data: extra.lastScreenshot },
          ],
        };
      }

      return { observation, tier };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unknown page handle')) {
        extra.pageId = undefined;
        throw new Error(`Page lost: ${msg}`);
      }
      return { observation: `Observation error: ${msg}` };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Act callback — browser interactions
  // ═══════════════════════════════════════════════════════════════════

  private async handleAct(taskId: string, action: AgentAction): Promise<{ success: boolean; data?: unknown; error?: string }> {
    const extra = this.taskExtras.get(taskId);
    if (!extra?.pageId) return { success: false, error: 'No page open' };

    const webId = this.webBrowserId!;
    const pageId = extra.pageId;
    const ref = action.ref as string | undefined;

    // Log the action with its key parameter
    const actionParam = ref ?? action.selector ?? action.url ?? action.key ?? action.script?.toString().slice(0, 40) ?? '';
    log.info(`Act: ${action.action}${actionParam ? ' ' + actionParam : ''}${action.value ? ' value="' + String(action.value).slice(0, 30) + '"' : ''}`);

    try {
      switch (action.action) {
        case 'navigate':
          await this.request(request(this.id, webId, 'navigateTo', {
            pageId, url: action.url as string,
          }));
          return { success: true, data: { navigated: action.url } };

        case 'click':
          if (ref) {
            await this.request(request(this.id, webId, 'refAction', { pageId, ref, action: 'click' }));
          } else {
            await this.request(request(this.id, webId, 'click', { pageId, selector: action.selector as string }));
          }
          return { success: true, data: { clicked: ref ?? action.selector } };

        case 'fill':
          if (ref) {
            await this.request(request(this.id, webId, 'refAction', { pageId, ref, action: 'fill', value: action.value as string }));
          } else {
            await this.request(request(this.id, webId, 'fill', { pageId, selector: action.selector as string, value: action.value as string }));
          }
          return { success: true, data: { filled: ref ?? action.selector } };

        case 'type':
          if (ref) {
            await this.request(request(this.id, webId, 'refAction', { pageId, ref, action: 'type', value: action.text as string }));
          } else {
            await this.request(request(this.id, webId, 'type', { pageId, selector: action.selector as string, text: action.text as string }));
          }
          return { success: true, data: { typed: ref ?? action.selector } };

        case 'press':
          if (ref) {
            await this.request(request(this.id, webId, 'refAction', { pageId, ref, action: 'press', value: action.key as string }));
          } else {
            await this.request(request(this.id, webId, 'press', { pageId, key: action.key as string }));
          }
          return { success: true, data: { pressed: action.key } };

        case 'select':
          if (ref) {
            await this.request(request(this.id, webId, 'refAction', { pageId, ref, action: 'selectOption', value: (action.values as string[])?.[0] }));
          } else {
            await this.request(request(this.id, webId, 'select', { pageId, selector: action.selector as string, values: action.values as string[] }));
          }
          return { success: true, data: { selected: ref ?? action.selector } };

        case 'hover':
          if (ref) {
            await this.request(request(this.id, webId, 'refAction', { pageId, ref, action: 'hover' }));
          } else {
            await this.request(request(this.id, webId, 'hover', { pageId, selector: action.selector as string }));
          }
          return { success: true, data: { hovered: ref ?? action.selector } };

        case 'check':
          if (ref) {
            await this.request(request(this.id, webId, 'refAction', { pageId, ref, action: 'check' }));
          } else {
            await this.request(request(this.id, webId, 'check', { pageId, selector: action.selector as string }));
          }
          return { success: true, data: { checked: ref ?? action.selector } };

        case 'uncheck':
          if (ref) {
            await this.request(request(this.id, webId, 'refAction', { pageId, ref, action: 'uncheck' }));
          } else {
            await this.request(request(this.id, webId, 'uncheck', { pageId, selector: action.selector as string }));
          }
          return { success: true, data: { unchecked: ref ?? action.selector } };

        case 'wait':
          await this.request(request(this.id, webId, 'waitForSelector', {
            pageId,
            selector: action.selector as string,
            options: { timeout: (action.timeout as number) ?? 10000 },
          }));
          return { success: true, data: { waited: action.selector } };

        case 'extract': {
          const result = await this.request<{ result: unknown }>(
            request(this.id, webId, 'evaluate', {
              pageId, script: action.script as string,
            })
          );
          return { success: true, data: result.result };
        }

        default:
          return { success: false, error: `Unknown action: ${action.action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Unknown page handle')) {
        extra.pageId = undefined;
        throw new Error(`Page lost: ${msg}`);
      }
      return { success: false, error: msg };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // System prompt
  // ═══════════════════════════════════════════════════════════════════

  private buildSystemPrompt(taskText: string, maxSteps?: number): string {
    const stepLimit = maxSteps ?? 15;
    return `You are WebAgent, an autonomous browser agent with vision. You receive an accessibility tree snapshot of the page alongside a screenshot. Each interactive element has a ref like [ref=e5]. Use refs to target elements in your actions.

You have a maximum of ${stepLimit} steps. Be efficient and call "done" as soon as you have useful data.

## Task
${taskText}

## ARIA Snapshot Format
The observation contains an accessibility tree in YAML-like format. Example:
- navigation [ref=e1]:
  - link "Home" [ref=e2]
  - link "About" [ref=e3]
- main [ref=e4]:
  - heading "Welcome" [level=1] [ref=e5]
  - textbox "Email" [ref=e6]
  - textbox "Password" [ref=e7]
  - button "Submit" [ref=e8]
  - combobox [ref=e9]:
    - option "Option A" [selected]
    - option "Option B"

Each element shows its role, name/label in quotes, attributes in brackets, and [ref=eN] for targeting.

## Action Format
Respond with ONE action as a JSON object in a \`\`\`json code block:

\`\`\`json
{ "action": "click", "ref": "e8", "reasoning": "Click the Submit button" }
\`\`\`

## Available Actions

### Navigation
- navigate: Go to a URL. { "action": "navigate", "url": "https://..." }

### Interaction (use "ref" to target elements from the ARIA snapshot)
- click: Click an element. { "action": "click", "ref": "e5" }
- fill: Clear and fill an input. { "action": "fill", "ref": "e6", "value": "text" }
- type: Type text without clearing. { "action": "type", "ref": "e6", "text": "text" }
- press: Press a keyboard key. { "action": "press", "key": "Enter" }
  Or press a key on a specific element: { "action": "press", "ref": "e6", "key": "Enter" }
- select: Select dropdown option. { "action": "select", "ref": "e9", "values": ["Option B"] }
- hover: Hover over an element. { "action": "hover", "ref": "e5" }
- check: Check a checkbox. { "action": "check", "ref": "e10" }
- uncheck: Uncheck a checkbox. { "action": "uncheck", "ref": "e10" }

### Extraction (escape hatch for complex JavaScript)
- extract: Run JavaScript in the page context. The script is evaluated as an expression.
  Simple: { "action": "extract", "script": "document.title" }
  Complex: { "action": "extract", "script": "(() => { const items = []; document.querySelectorAll('h2 a').forEach(a => items.push({title: a.textContent.trim(), url: a.href})); return items.slice(0, 10); })()" }
  For multi-statement scripts, wrap in an IIFE: (() => { ...code...; return result; })()
  For APIs or plain-text endpoints, use fetch: { "action": "extract", "script": "fetch('https://api.example.com/data').then(r => r.json())" }

### Task Decomposition
- decompose: Break a complex task into parallel sub-tasks dispatched to other agents.
  { "action": "decompose", "subtasks": [
    { "type": "browse", "description": "Navigate to page X and extract data" },
    { "type": "call", "description": "Fetch API endpoint Y" }
  ] }
  Use when the task requires multiple independent steps that could run in parallel.

### Terminal
- done: Task complete. { "action": "done", "result": "extracted data or summary" }
  To keep the page open for follow-up tasks: { "action": "done", "result": "...", "keepPageOpen": true }
- fail: Cannot complete. { "action": "fail", "reason": "why it cannot be done" }

## Page Lifecycle
By default, the browser page closes when you call "done" or "fail".
Add "keepPageOpen": true to your "done" action ONLY when:
- You logged into an account and the session should persist for follow-up tasks
- The page has state (filled forms, selected filters) that would be lost on reload
- The task description explicitly asks to keep the page open

Do NOT keep the page open when:
- You just extracted data or read content (the data is already in the result)
- You navigated to a public page with no session state
- The task is a one-shot lookup (weather, search, news headlines)

When in doubt, close the page (omit "keepPageOpen"). Pages left open consume resources.

## Rules
1. Use "ref" from the ARIA snapshot to target elements. The ref (e.g. "e5") comes from [ref=eN] annotations.
2. One action per response. Always include "reasoning" explaining why.
3. After filling a form, submit it (click the submit button or press Enter).
4. The ARIA snapshot shows the page's semantic structure and text content. Use it to understand the page before resorting to "extract".
5. As soon as you have useful data, call "done" immediately. Good enough is good enough.
6. If stuck after several attempts, use "fail" with a clear reason.
7. Do not retry the same action more than twice. If it fails twice, try a different approach or fail.
8. Keep reasoning brief (1-2 sentences).
9. Pay attention to the step counter. When steps are running low, call "done" with whatever you have.`;
  }
}

export const WEB_AGENT_ID = 'abjects:web-agent' as AbjectId;
