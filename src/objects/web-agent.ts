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
          'Autonomous browser agent. Accepts a task description, opens a browser page, and uses an LLM-driven think-act-observe loop to complete web tasks. Each phase is a visible job in JobBrowser.',
        version: '1.0.0',
        interface: {
          id: WEB_AGENT_INTERFACE,
          name: 'WebAgent',
          description: 'Autonomous web browser agent',
          methods: [
            {
              name: 'runTask',
              description: 'Run a full autonomous web task. Returns when complete.',
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
                  }}, description: 'Task options', optional: true,
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

  protected override getSourceForAsk(): string | undefined {
    return `## WebAgent Usage Guide

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

  protected override async onInit(): Promise<void> {
    this.webBrowserId = await this.requireDep('WebBrowser');
    this.consoleId = await this.discoverDep('Console') ?? undefined;
    this.agentAbjectId = await this.requireDep('AgentAbject');
    this.jobManagerId = await this.discoverDep('JobManager') ?? undefined;
    this.goalManagerId = await this.discoverDep('GoalManager') ?? undefined;

    // Register with AgentAbject
    await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'WebAgent',
      description: 'Autonomous browser agent for web tasks',
      taskTypes: ['browse', 'research', 'web'],
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

        // Keep page open with idle timeout (same as runTask default)
        if (extra.pageId) {
          this.trackKeptOpenPage(extra.pageId);
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
  }> {
    type TaskResult = { ticketId: string; success: boolean; result?: unknown; error?: string; steps: number; maxStepsReached?: boolean; validationErrors?: string[] };
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
      // Default: close the page (preserves existing behavior)
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

  private async handleObserve(taskId: string): Promise<{ observation: string; llmContent?: ContentPart[] }> {
    const extra = this.taskExtras.get(taskId);
    if (!extra?.pageId) return { observation: 'No page open.' };

    try {
      const urlResult = await this.request<{ url: string }>(
        request(this.id, this.webBrowserId!, 'getUrl', { pageId: extra.pageId })
      );
      const titleResult = await this.request<{ title: string }>(
        request(this.id, this.webBrowserId!, 'getTitle', { pageId: extra.pageId })
      );

      const extractionScript = `
        (() => {
          const interactiveSelectors = 'input, button, a, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="tab"], [onclick]';
          const elements = [];
          const seen = new Set();
          for (const el of document.querySelectorAll(interactiveSelectors)) {
            if (elements.length >= 100) break;
            const tag = el.tagName.toLowerCase();
            const type = el.getAttribute('type') || '';
            const text = (el.textContent || '').trim().slice(0, 80);
            const placeholder = el.getAttribute('placeholder') || '';
            const href = el.getAttribute('href') || '';
            const value = el instanceof HTMLInputElement ? el.value.slice(0, 80) : '';
            const ariaLabel = el.getAttribute('aria-label') || '';
            const name = el.getAttribute('name') || '';
            const id = el.getAttribute('id') || '';
            const role = el.getAttribute('role') || '';

            let selector = tag;
            let canQuery = true;
            if (id) selector = '#' + CSS.escape(id);
            else if (name) selector = tag + '[name="' + name.replace(/"/g, '\\\\"') + '"]';
            else if (ariaLabel) selector = tag + '[aria-label="' + ariaLabel.replace(/"/g, '\\\\"') + '"]';
            else if (type && tag === 'input') selector = 'input[type="' + type + '"]';
            else if (text && tag !== 'input') {
              // Use XPath-style hint for LLM readability (not a CSS selector)
              selector = tag + '[text="' + text.slice(0, 40).replace(/"/g, '\\\\"') + '"]';
              canQuery = false;
            }

            if (seen.has(selector) && canQuery) {
              try {
                const siblings = document.querySelectorAll(selector);
                const idx = Array.from(siblings).indexOf(el);
                if (idx >= 0) selector += ':nth-of-type(' + (idx + 1) + ')';
              } catch (_e) { /* selector not queryable */ }
            }
            seen.add(selector);

            elements.push({ tag, type, selector, text, placeholder, href, value, ariaLabel, role });
          }

          const bodyText = document.body ? document.body.innerText.slice(0, 15000) : '';
          return { elements, bodyText };
        })()
      `;

      const evalResult = await this.request<{ result: unknown }>(
        request(this.id, this.webBrowserId!, 'evaluate', {
          pageId: extra.pageId,
          script: extractionScript,
        })
      );

      const pageData = evalResult.result as { elements: Array<Record<string, string>>; bodyText: string };

      const elementCount = (pageData?.elements ?? []).length;
      log.info(`Observe: URL=${urlResult.url} | ${elementCount} elements`);

      const lines: string[] = [];
      lines.push(`URL: ${urlResult.url}`);
      lines.push(`Title: ${titleResult.title}`);
      lines.push('');
      lines.push('Interactive elements:');
      for (const el of (pageData?.elements ?? [])) {
        const parts = [`[${el.tag}${el.type ? ' type=' + el.type : ''}]`];
        parts.push(`selector="${el.selector}"`);
        if (el.text) parts.push(`text="${el.text}"`);
        if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
        if (el.href) parts.push(`href="${el.href}"`);
        if (el.value) parts.push(`value="${el.value}"`);
        if (el.ariaLabel) parts.push(`aria-label="${el.ariaLabel}"`);
        lines.push('  ' + parts.join(' '));
      }
      lines.push('');
      lines.push('Page text (truncated):');
      lines.push((pageData?.bodyText ?? '').slice(0, 8000));

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
          llmContent: [
            { type: 'text' as const, text: `[Observation - Step]\n${observation}` },
            { type: 'image' as const, mediaType: 'image/png' as const, data: extra.lastScreenshot },
          ],
        };
      }

      return { observation };
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

    // Log the action with its key parameter
    const actionParam = action.selector ?? action.url ?? action.key ?? action.script?.toString().slice(0, 40) ?? '';
    log.info(`Act: ${action.action}${actionParam ? ' ' + actionParam : ''}${action.value ? ' value="' + String(action.value).slice(0, 30) + '"' : ''}`);

    try {
      switch (action.action) {
        case 'navigate':
          await this.request(request(this.id, webId, 'navigateTo', {
            pageId, url: action.url as string,
          }));
          return { success: true, data: { navigated: action.url } };

        case 'click':
          await this.request(request(this.id, webId, 'click', {
            pageId, selector: action.selector as string,
          }));
          return { success: true, data: { clicked: action.selector } };

        case 'fill':
          await this.request(request(this.id, webId, 'fill', {
            pageId, selector: action.selector as string, value: action.value as string,
          }));
          return { success: true, data: { filled: action.selector } };

        case 'type':
          await this.request(request(this.id, webId, 'type', {
            pageId, selector: action.selector as string, text: action.text as string,
          }));
          return { success: true, data: { typed: action.selector } };

        case 'press':
          await this.request(request(this.id, webId, 'press', {
            pageId, key: action.key as string,
          }));
          return { success: true, data: { pressed: action.key } };

        case 'select':
          await this.request(request(this.id, webId, 'select', {
            pageId, selector: action.selector as string, values: action.values as string[],
          }));
          return { success: true, data: { selected: action.selector } };

        case 'hover':
          await this.request(request(this.id, webId, 'hover', {
            pageId, selector: action.selector as string,
          }));
          return { success: true, data: { hovered: action.selector } };

        case 'check':
          await this.request(request(this.id, webId, 'check', {
            pageId, selector: action.selector as string,
          }));
          return { success: true, data: { checked: action.selector } };

        case 'uncheck':
          await this.request(request(this.id, webId, 'uncheck', {
            pageId, selector: action.selector as string,
          }));
          return { success: true, data: { unchecked: action.selector } };

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
    return `You are WebAgent, an autonomous browser agent with vision. You receive a screenshot of the current page alongside text observations. Use the visual information to understand page layout, identify elements, and verify your actions succeeded. You complete web tasks by observing the page state, thinking about what to do, and taking actions.

You have a maximum of ${stepLimit} steps. Be efficient — extract what you can quickly and call "done" as soon as you have useful data. Do NOT keep refining or perfecting the result.

## Task
${taskText}

## Action Format
Respond with ONE action as a JSON object in a \`\`\`json code block:

\`\`\`json
{ "action": "click", "selector": "#login-btn", "reasoning": "Click the login button" }
\`\`\`

## Available Actions

### Navigation
- navigate: Go to a URL. { "action": "navigate", "url": "https://..." }

### Interaction
- click: Click an element. { "action": "click", "selector": "CSS selector" }
- fill: Clear and fill an input. { "action": "fill", "selector": "CSS selector", "value": "text" }
- type: Type text without clearing. { "action": "type", "selector": "CSS selector", "text": "text" }
- press: Press a keyboard key. { "action": "press", "key": "Enter" }
- select: Select dropdown option(s). { "action": "select", "selector": "CSS selector", "values": ["option"] }
- hover: Hover over an element. { "action": "hover", "selector": "CSS selector" }
- check: Check a checkbox. { "action": "check", "selector": "CSS selector" }
- uncheck: Uncheck a checkbox. { "action": "uncheck", "selector": "CSS selector" }

### Waiting
- wait: Wait for an element. { "action": "wait", "selector": "CSS selector", "timeout": 5000 }

### Extraction
- extract: Run JavaScript in the page context. The script is evaluated as an expression.
  Simple: { "action": "extract", "script": "document.title" }
  Complex: { "action": "extract", "script": "(() => { const items = []; document.querySelectorAll('h2 a').forEach(a => items.push({title: a.textContent.trim(), url: a.href})); return items.slice(0, 10); })()" }
  IMPORTANT: For multi-statement scripts, wrap in an IIFE: (() => { ...code...; return result; })()

### Terminal
- done: Task complete. { "action": "done", "result": "extracted data or summary" }
- fail: Cannot complete. { "action": "fail", "reason": "why it cannot be done" }

## Extraction Tips
- Start simple: extract document.body.innerText first, then parse the text.
- Use broad selectors: 'h1, h2, h3' or 'article' rather than site-specific class names.
- For news headlines: 'h2 a, h3 a, [class*="headline"] a, article a' catches most sites.
- Keep scripts under 500 chars — shorter scripts have fewer bugs.
- Always use an IIFE for multi-statement scripts: (() => { ... return result; })()
- For APIs or plain-text endpoints (like wttr.in, jsonplaceholder, etc.), use extract with fetch:
  { "action": "extract", "script": "fetch('https://wttr.in/NYC?format=4').then(r => r.text())" }
  This avoids navigation issues with non-HTML responses.

## Rules
1. Use CSS selectors from the observation. Prefer #id selectors when available.
2. One action per response. Always include "reasoning" explaining why.
3. After filling a form, remember to submit it (click submit button or press Enter).
4. If a page is loading or elements aren't visible yet, use "wait".
5. **As soon as you have extracted useful data, call "done" immediately.** Do not keep refining or extracting more. Good enough is good enough.
6. If stuck after several attempts, use "fail" with a clear reason.
7. If an extract script fails, try a simpler approach (e.g., just get document.title or document.body.innerText).
8. If a page returns an error or is blocked by bot detection, use "fail" with a clear reason instead of retrying the same page.
9. Do not retry the same action more than twice. If it fails twice, try a different approach or fail.
10. Keep reasoning brief (1-2 sentences).
11. Pay attention to the step counter in observations. When steps are running low, call "done" with whatever you have.`;
  }
}

export const WEB_AGENT_ID = 'abjects:web-agent' as AbjectId;
