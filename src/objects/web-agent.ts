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

const WEB_AGENT_INTERFACE: InterfaceId = 'abjects:web-agent';

interface WebTaskOptions {
  maxSteps?: number;
  startUrl?: string;
  timeout?: number;
  pageOptions?: { userAgent?: string; viewport?: { width: number; height: number } };
}

/** Per-task extra state (page IDs, startUrl, screenshots). */
interface WebTaskExtra {
  startUrl?: string;
  pageId?: string;
  pageOptions?: { userAgent?: string; viewport?: { width: number; height: number } };
  lastScreenshot?: string;  // raw base64 (no data URI prefix)
}

// ─── WebAgent ───────────────────────────────────────────────────────

export class WebAgent extends Abject {
  private webBrowserId?: AbjectId;
  private consoleId?: AbjectId;
  private agentAbjectId?: AbjectId;
  private jobManagerId?: AbjectId;

  /** Per-task extra state (page IDs, startUrl, etc.). */
  private taskExtras = new Map<string, WebTaskExtra>();

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
                  }}, description: 'Task options', optional: true,
                },
              ],
              returns: { kind: 'object', properties: {
                success: { kind: 'primitive', primitive: 'boolean' },
                result: { kind: 'primitive', primitive: 'string' },
                steps: { kind: 'primitive', primitive: 'number' },
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

  protected override async onInit(): Promise<void> {
    this.webBrowserId = await this.requireDep('WebBrowser');
    this.consoleId = await this.discoverDep('Console') ?? undefined;
    this.agentAbjectId = await this.requireDep('AgentAbject');
    this.jobManagerId = await this.discoverDep('JobManager') ?? undefined;

    // Register with AgentAbject
    await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'WebAgent',
      description: 'Autonomous browser agent for web tasks',
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
    this.on('runTask', async (msg: AbjectMessage) => {
      const { task, options } = msg.payload as { task: string; options?: WebTaskOptions };
      contractRequire(typeof task === 'string' && task.trim().length > 0, 'task must be a non-empty string');

      const taskId = `web-task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      console.log(`[WebAgent] ► runTask (${taskId}): "${task.trim().slice(0, 80)}"`);

      const extra: WebTaskExtra = {
        startUrl: options?.startUrl,
        pageOptions: options?.pageOptions,
      };
      this.taskExtras.set(taskId, extra);

      // Fire-and-forget: run task asynchronously via AgentAbject
      this.runTaskAsync(msg, taskId, task.trim(), extra, options);
      return DEFERRED_REPLY;
    });

    this.on('runStep', async (msg: AbjectMessage) => {
      const { pageId, instruction } = msg.payload as { pageId: string; instruction: string };
      contractRequire(typeof pageId === 'string', 'pageId required');
      contractRequire(typeof instruction === 'string', 'instruction required');

      const taskId = `web-step-${Date.now()}`;
      this.taskExtras.set(taskId, { pageId });

      // For single steps, use directExecution to avoid queue deadlocks
      const result = await this.request<{
        taskId: string;
        success: boolean;
        result?: unknown;
        error?: string;
        steps: number;
      }>(
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
        130000,
      );

      return { success: result.success, result: result.result, error: result.error };
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
      this.changed('taskProgress', { taskId, step, phase: newPhase, action }).catch(() => {});

      // Forward progress to JobManager to keep the outer call alive
      if (this.jobManagerId) {
        this.send(event(this.id, this.jobManagerId, 'progress', { phase: newPhase })).catch(() => {});
      }
    });

    this.on('agentIntermediateAction', async () => { /* no-op for WebAgent */ });
    this.on('agentActionResult', async () => { /* no-op for WebAgent */ });
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
    let result: { taskId: string; success: boolean; result?: unknown; error?: string; steps: number };

    try {
      // Open page
      if (!extra.pageId) {
        console.log(`[WebAgent] Opening page (${taskId})`);
        const pageResult = await this.request<{ pageId: string }>(
          request(this.id, this.webBrowserId!, 'openPage', {
            options: extra.pageOptions,
          })
        );
        extra.pageId = pageResult.pageId;

        if (extra.startUrl) {
          console.log(`[WebAgent] Navigating to ${extra.startUrl}`);
          await this.request(
            request(this.id, this.webBrowserId!, 'navigateTo', {
              pageId: extra.pageId,
              url: extra.startUrl,
            })
          );
        }
      }

      // Run task via AgentAbject
      result = await this.request<{
        taskId: string;
        success: boolean;
        result?: unknown;
        error?: string;
        steps: number;
      }>(
        request(this.id, this.agentAbjectId!, 'startTask', {
          taskId,
          task: taskText,
          systemPrompt: this.buildSystemPrompt(taskText),
          config: {
            maxSteps: options?.maxSteps,
            timeout: options?.timeout,
            queueName: `web-agent-${this.id}`,
          },
        }),
        (options?.timeout ?? 300000) + 10000,
      );
    } catch (err) {
      result = {
        taskId,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        steps: 0,
      };
    } finally {
      // Always close the page we opened
      if (extra.pageId) {
        try {
          await this.request(
            request(this.id, this.webBrowserId!, 'closePage', { pageId: extra.pageId })
          );
        } catch { /* best effort */ }
      }
    }

    if (result.success) {
      console.log(`[WebAgent] ✓ Task complete (${taskId}) in ${result.steps} steps`);
    }

    try {
      await this.sendDeferredReply(originalMsg, {
        success: result.success,
        result: result.result,
        error: result.error,
        steps: result.steps,
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
      console.log(`[WebAgent] Observe: URL=${urlResult.url} | ${elementCount} elements`);

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
      return { observation: `Observation error: ${err instanceof Error ? err.message : String(err)}` };
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
    console.log(`[WebAgent] Act: ${action.action}${actionParam ? ' ' + actionParam : ''}${action.value ? ' value="' + String(action.value).slice(0, 30) + '"' : ''}`);

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
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // System prompt
  // ═══════════════════════════════════════════════════════════════════

  private buildSystemPrompt(taskText: string): string {
    return `You are WebAgent, an autonomous browser agent with vision. You receive a screenshot of the current page alongside text observations. Use the visual information to understand page layout, identify elements, and verify your actions succeeded. You complete web tasks by observing the page state, thinking about what to do, and taking actions.

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
- extract: Run JavaScript on the page. { "action": "extract", "script": "return document.title" }

### Terminal
- done: Task complete. { "action": "done", "result": "extracted data or summary" }
- fail: Cannot complete. { "action": "fail", "reason": "why it cannot be done" }

## Rules
1. Use CSS selectors from the observation. Prefer #id selectors when available.
2. One action per response. Always include "reasoning" explaining why.
3. After filling a form, remember to submit it (click submit button or press Enter).
4. If a page is loading or elements aren't visible yet, use "wait".
5. When the task is complete, use "done" with the result.
6. If stuck after several attempts, use "fail" with a clear reason.
7. Keep reasoning brief (1-2 sentences).`;
  }
}

export const WEB_AGENT_ID = 'abjects:web-agent' as AbjectId;
