/**
 * Chat — conversational LLM agent.
 *
 * Provides a chat window where users can type natural language requests.
 * The agent decides whether to just chat or take action by submitting
 * code-execution jobs to the JobManager. Displays inline step progress.
 */

import { AbjectId, AbjectManifest, AbjectMessage, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { invariant } from '../core/contracts.js';
import { INTROSPECT_INTERFACE_ID } from '../core/introspect.js';
import { formatManifestAsDescription } from '../core/introspect.js';
import type { JobResult } from './job-manager.js';

const CHAT_INTERFACE: InterfaceId = 'abjects:chat';
const WIDGETS_INTERFACE: InterfaceId = 'abjects:widgets';
const WIDGET_INTERFACE: InterfaceId = 'abjects:widget';
const LAYOUT_INTERFACE: InterfaceId = 'abjects:layout';
const JOBMANAGER_INTERFACE: InterfaceId = 'abjects:job-manager';

const WIN_W = 500;
const WIN_H = 500;
const MAX_FOLLOW_UP_ROUNDS = 5;
const MAX_CONVERSATION_ENTRIES = 40;

type ChatPhase = 'closed' | 'idle' | 'thinking' | 'executing';

interface ConversationEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface AgentStep {
  description: string;
  code: string;
}

interface AgentResponse {
  reply: string;
  steps?: AgentStep[];
}

interface ObjectSummary {
  id: AbjectId;
  name: string;
  description: string;
}

interface SelectedDependency {
  id: AbjectId;
  name: string;
  manifest: AbjectManifest;
  description: string;
}

export class Chat extends Abject {
  private llmId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;
  private jobManagerId?: AbjectId;

  // Window/widget IDs
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private messageLogId?: AbjectId;
  private inputRowId?: AbjectId;
  private textInputId?: AbjectId;
  private sendBtnId?: AbjectId;

  private messageLabelIds: AbjectId[] = [];
  private conversationHistory: ConversationEntry[] = [];
  private objectSummaries = '';
  private usageGuideCache: Map<string, { guide: string; fetchedAt: number }> = new Map();
  private readonly GUIDE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private enrichedObjectContext = '';
  private phase: ChatPhase = 'closed';

  /** Check if phase is 'closed'. Separate method to avoid TS narrowing issues across async boundaries. */
  private get isClosed(): boolean { return this.phase === 'closed'; }

  constructor() {
    super({
      manifest: {
        name: 'Chat',
        description:
          'Conversational LLM agent. Chat naturally to explore, create, and control objects. Submits jobs to JobManager for execution.',
        version: '1.0.0',
        interfaces: [
          {
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
        ],
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
    this.llmId = await this.requireDep('LLM');
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.registryId = await this.requireDep('Registry');
    this.jobManagerId = await this.requireDep('JobManager');
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    for (const [, entry] of this.usageGuideCache) {
      invariant(entry.fetchedAt > 0, 'Usage guide cache entry must have a positive timestamp');
    }
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
        phase: this.phase,
        messageCount: this.conversationHistory.length,
        visible: !!this.windowId,
      };
    });

    this.on('clearHistory', async () => {
      this.conversationHistory = [];
      this.usageGuideCache.clear();
      this.enrichedObjectContext = '';
      if (this.windowId) {
        await this.clearMessageLabels();
        await this.appendMessageLabel('Agent', 'How can I help you?', '#a8cc8c');
      }
      return true;
    });

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
    });
  }

  async show(): Promise<boolean> {
    if (this.windowId) {
      try {
        await this.request(request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'raiseWindow', {
          windowId: this.windowId,
        }));
      } catch { /* best effort */ }
      return true;
    }

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'getDisplayInfo', {})
    );

    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createWindowAbject', {
        title: 'Chat Agent',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 6,
      })
    );

    // Scrollable VBox for message log (expanding)
    this.messageLogId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.messageLogId,
      sizePolicy: { vertical: 'expanding', horizontal: 'expanding' },
    }));

    // Input row (HBox: TextInput + Send button)
    this.inputRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );
    await this.request(request(this.id, this.rootLayoutId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.inputRowId,
      sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    // Text input (expanding)
    this.textInputId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createTextInput', {
        windowId: this.windowId,
        rect: r0,
        placeholder: 'Type a message...',
      })
    );
    await this.request(request(this.id, this.inputRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.textInputId,
      sizePolicy: { horizontal: 'expanding' },
      preferredSize: { height: 36 },
    }));

    // Send button (fixed)
    this.sendBtnId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createButton', {
        windowId: this.windowId,
        rect: r0,
        text: 'Send',
        style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' },
      })
    );
    await this.request(request(this.id, this.inputRowId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: this.sendBtnId,
      sizePolicy: { horizontal: 'fixed' },
      preferredSize: { width: 60, height: 36 },
    }));

    // Register as dependent of interactive widgets
    await this.request(request(this.id, this.sendBtnId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));
    await this.request(request(this.id, this.textInputId, INTROSPECT_INTERFACE_ID, 'addDependent', {}));

    this.phase = 'idle';

    // Show greeting
    await this.appendMessageLabel('Agent', 'How can I help you?', '#a8cc8c');

    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    this.phase = 'closed';

    await this.request(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'destroyWindowAbject', {
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
    this.enrichedObjectContext = '';
    return true;
  }

  private async handleSendClick(): Promise<void> {
    if (this.phase !== 'idle' || !this.textInputId) return;

    const text = await this.request<string>(
      request(this.id, this.textInputId, WIDGET_INTERFACE, 'getValue', {})
    );

    if (!text?.trim()) return;

    // Clear input
    await this.request(
      request(this.id, this.textInputId, WIDGET_INTERFACE, 'update', { text: '' })
    );

    this.triggerSend(text.trim());
  }

  private triggerSend(text: string): void {
    if (this.phase !== 'idle') return;
    // Fire-and-forget — don't block the message processing loop
    this.runAgentLoop(text);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Agent Loop
  // ═══════════════════════════════════════════════════════════════════

  private async runAgentLoop(userText: string): Promise<void> {
    if (this.phase === 'closed') return;
    this.phase = 'thinking';

    // Show user message
    await this.appendMessageLabel('You', userText, '#e2e4e9');
    this.conversationHistory.push({ role: 'user', content: userText });

    // Show thinking indicator
    const thinkingLabelId = await this.appendMessageLabel('', 'Thinking...', '#6b7084');

    try {
      // Refresh context if stale
      await this.refreshObjectSummaries();

      // ── Pass 1: LLM call with lightweight summaries ──
      const messages = this.buildLLMMessages();

      const llmResult = await this.request<{ content: string }>(
        request(this.id, this.llmId!, 'abjects:llm' as InterfaceId, 'complete', {
          messages,
          options: { tier: 'balanced' },
        }),
        120000,
      );

      if (this.isClosed) return;

      // Parse Pass 1 response
      let agentResponse = this.parseAgentResponse(llmResult.content);
      let finalContent = llmResult.content;

      // ── Pass 2: If steps detected, run discovery and re-call LLM ──
      if (agentResponse.steps && agentResponse.steps.length > 0) {
        await this.updateLabel(thinkingLabelId, 'Discovering relevant objects...', '#6b7084');
        const enrichedContext = await this.runDiscoveryPipeline(userText);

        if (enrichedContext && !this.isClosed) {
          await this.updateLabel(thinkingLabelId, 'Refining plan...', '#6b7084');
          this.enrichedObjectContext = enrichedContext;

          const enrichedMessages = this.buildLLMMessages(true);
          const pass2Result = await this.request<{ content: string }>(
            request(this.id, this.llmId!, 'abjects:llm' as InterfaceId, 'complete', {
              messages: enrichedMessages,
              options: { tier: 'balanced' },
            }),
            120000,
          );

          if (!this.isClosed) {
            agentResponse = this.parseAgentResponse(pass2Result.content);
            finalContent = pass2Result.content;
          }
        }
      }

      // Remove thinking indicator
      await this.removeLabel(thinkingLabelId);

      if (this.isClosed) return;

      // Display reply
      if (agentResponse.reply) {
        await this.appendMessageLabel('Agent', agentResponse.reply, '#a8cc8c');
        this.conversationHistory.push({ role: 'assistant', content: finalContent });
      }

      // Execute steps if any
      if (agentResponse.steps && agentResponse.steps.length > 0) {
        await this.executeStepsLoop(agentResponse.steps, 0);
      } else {
        this.phase = 'idle';
      }
    } catch (err) {
      // Remove thinking indicator if still there
      await this.removeLabel(thinkingLabelId);

      const errMsg = err instanceof Error ? err.message : String(err);
      await this.appendMessageLabel('Error', errMsg.slice(0, 100), '#e05561');
      this.phase = this.windowId ? 'idle' : 'closed';
    }
  }

  private async executeStepsLoop(steps: AgentStep[], round: number): Promise<void> {
    if (this.isClosed) return;
    this.phase = 'executing';

    const stepResults: { description: string; success: boolean; result?: unknown; error?: string }[] = [];
    let previousResult: unknown = undefined;

    for (const step of steps) {
      if (this.isClosed) return;

      // Show step indicator
      const stepLabelId = await this.appendMessageLabel('', `  ▸ ${step.description}...`, '#e8a84c');

      try {
        // Wrap code to inject previousResult
        const wrappedCode = `const previousResult = ${JSON.stringify(previousResult)};\n${step.code}`;

        const jobResult = await this.request<JobResult>(
          request(this.id, this.jobManagerId!, JOBMANAGER_INTERFACE, 'submitJob', {
            description: step.description,
            code: wrappedCode,
          }),
          120000,
        );

        if (jobResult.status === 'completed') {
          await this.updateLabel(stepLabelId, `  ✓ ${step.description}`, '#6b7084');
          previousResult = jobResult.result;
          stepResults.push({ description: step.description, success: true, result: jobResult.result });
        } else {
          await this.updateLabel(stepLabelId, `  ✗ ${step.description}`, '#e05561');
          stepResults.push({ description: step.description, success: false, error: jobResult.error });
          // Stop executing remaining steps on failure
          break;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.updateLabel(stepLabelId, `  ✗ ${step.description}`, '#e05561');
        stepResults.push({ description: step.description, success: false, error: errMsg });
        break;
      }
    }

    if (this.isClosed) return;

    // Feed results back to LLM
    const resultSummary = stepResults.map(r =>
      r.success
        ? `✓ ${r.description}: ${JSON.stringify(r.result)?.slice(0, 200) ?? 'ok'}`
        : `✗ ${r.description}: ${r.error ?? 'unknown error'}`
    ).join('\n');

    this.conversationHistory.push({
      role: 'user',
      content: `Step execution results:\n${resultSummary}`,
    });

    // Follow-up: ask LLM for summary or more steps
    if (round < MAX_FOLLOW_UP_ROUNDS) {
      this.phase = 'thinking';
      const thinkingLabelId = await this.appendMessageLabel('', 'Thinking...', '#6b7084');

      try {
        const messages = this.buildLLMMessages(!!this.enrichedObjectContext);
        const followUp = await this.request<{ content: string }>(
          request(this.id, this.llmId!, 'abjects:llm' as InterfaceId, 'complete', {
            messages,
            options: { tier: 'balanced' },
          }),
          120000,
        );

        await this.removeLabel(thinkingLabelId);
        if (this.isClosed) return;

        const parsed = this.parseAgentResponse(followUp.content);

        if (parsed.reply) {
          await this.appendMessageLabel('Agent', parsed.reply, '#a8cc8c');
          this.conversationHistory.push({ role: 'assistant', content: followUp.content });
        }

        if (parsed.steps && parsed.steps.length > 0) {
          await this.executeStepsLoop(parsed.steps, round + 1);
          return;
        }
      } catch (err) {
        await this.removeLabel(thinkingLabelId);
        const errMsg = err instanceof Error ? err.message : String(err);
        await this.appendMessageLabel('Error', errMsg.slice(0, 100), '#e05561');
      }
    }

    this.phase = this.windowId ? 'idle' : 'closed';
  }

  // ═══════════════════════════════════════════════════════════════════
  // LLM Prompt Construction
  // ═══════════════════════════════════════════════════════════════════

  private async refreshObjectSummaries(): Promise<void> {
    if (this.objectSummaries && this.conversationHistory.length < 5) return;

    try {
      const objects = await this.request<ObjectRegistration[]>(
        request(this.id, this.registryId!, 'abjects:registry' as InterfaceId, 'list', {})
      );

      this.objectSummaries = objects
        .map(obj => formatManifestAsDescription(obj.manifest))
        .join('\n\n---\n\n');
    } catch {
      // Keep existing summaries if refresh fails
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Discovery Pipeline
  // ═══════════════════════════════════════════════════════════════════

  /** Phase 0a: Get lightweight summaries of all registered objects. */
  private async discoverObjectSummaries(): Promise<ObjectSummary[]> {
    if (!this.registryId) return [];
    const allObjects = await this.request<ObjectRegistration[]>(
      request(this.id, this.registryId, 'abjects:registry' as InterfaceId, 'list', {})
    );
    return allObjects.map((o) => ({
      id: o.id,
      name: o.manifest.name,
      description: o.manifest.description,
    }));
  }

  /** Phase 0b: Ask LLM to select which objects are relevant to the user's request. */
  private async llmSelectRelevantObjects(
    userText: string,
    summaries: ObjectSummary[]
  ): Promise<string[]> {
    if (summaries.length === 0 || !this.llmId) return [];

    const summaryText = summaries
      .map((s) => `- ${s.name}: ${s.description}`)
      .join('\n');

    const result = await this.request<{ content: string }>(
      request(this.id, this.llmId, 'abjects:llm' as InterfaceId, 'complete', {
        messages: [
          {
            role: 'system',
            content:
              'Given a list of object names and descriptions, return ONLY the names of objects relevant to the user\'s request. ' +
              'Study each object\'s description to determine if the user\'s request involves its methods or events. ' +
              'Return one name per line, nothing else. If no objects are relevant, return "None".',
          },
          {
            role: 'user',
            content: `Available objects:\n${summaryText}\n\nUser request: ${userText}\n\nWhich objects are relevant?`,
          },
        ],
        options: { tier: 'fast' },
      }),
      30000,
    );

    const content = result.content.trim();
    if (content.toLowerCase() === 'none') return [];

    return content
      .split('\n')
      .map((n) => n.trim().replace(/^-\s*/, ''))
      .filter((n) => n.length > 0 && n.toLowerCase() !== 'none');
  }

  /** Phase 0c: Introspect selected objects to get full manifests. */
  private async fetchFullManifests(
    selectedNames: string[],
    summaries: ObjectSummary[]
  ): Promise<SelectedDependency[]> {
    const deps: SelectedDependency[] = [];

    for (const name of selectedNames) {
      const summary = summaries.find(
        (s) => s.name.toLowerCase() === name.toLowerCase()
      );
      if (!summary) continue;

      try {
        const result = await this.request<{ manifest: AbjectManifest; description: string }>(
          request(this.id, summary.id, INTROSPECT_INTERFACE_ID, 'describe', {})
        );
        if (result) {
          deps.push({
            id: summary.id,
            name: result.manifest.name,
            manifest: result.manifest,
            description: result.description,
          });
        }
      } catch {
        // Skip objects that fail to respond
      }
    }

    return deps;
  }

  /** Phase 0c5: LLM generates one targeted question per dependency. */
  private async generateTargetedQuestions(
    userText: string,
    deps: SelectedDependency[]
  ): Promise<Map<string, string>> {
    if (deps.length === 0 || !this.llmId) return new Map();

    try {
      const depList = deps
        .map((d) => `- ${d.name}: ${d.description.slice(0, 300)}`)
        .join('\n');

      const result = await this.request<{ content: string }>(
        request(this.id, this.llmId, 'abjects:llm' as InterfaceId, 'complete', {
          messages: [
            {
              role: 'system',
              content:
                'You are helping a chat agent interact with objects in a distributed system. ' +
                'Given the user\'s request and a list of relevant objects, generate ONE targeted question per object. ' +
                'Each question should ask the object specifically how to accomplish what the user needs, referencing concrete methods or events.\n\n' +
                'Format: one line per object, exactly like this:\n' +
                '[ObjectName]: Your targeted question here?\n\n' +
                'Output ONLY the questions, one per line. Nothing else.',
            },
            {
              role: 'user',
              content:
                `User wants to: ${userText}\n\nRelevant objects:\n${depList}\n\n` +
                `Generate a targeted question for each object.`,
            },
          ],
          options: { tier: 'fast' },
        }),
        30000,
      );

      return this.parseTargetedQuestions(result.content, deps.map((d) => d.name));
    } catch {
      return new Map();
    }
  }

  /** Parse LLM response for targeted questions. Matches "[Name]: question" or "Name: question". */
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

  /** Phase 0d: Ask each relevant object for a usage guide via 'ask' protocol, in parallel. */
  private async fetchUsageGuides(
    deps: SelectedDependency[],
    customQuestions?: Map<string, string>
  ): Promise<Map<string, string>> {
    const guides = new Map<string, string>();
    if (deps.length === 0) return guides;

    const now = Date.now();
    const genericQuestion =
      'How should another object use your methods? Give a concise guide with example call() invocations and any important constraints.';

    const promises = deps.map(async (dep) => {
      // Check cache first
      const cached = this.usageGuideCache.get(dep.name);
      if (cached && (now - cached.fetchedAt) < this.GUIDE_CACHE_TTL) {
        guides.set(dep.name, cached.guide);
        return;
      }

      const question = customQuestions?.get(dep.name) ?? genericQuestion;
      try {
        const guide = await this.request<string>(
          request(this.id, dep.id, INTROSPECT_INTERFACE_ID, 'ask', { question }),
          60000
        );
        if (guide) {
          guides.set(dep.name, guide);
          this.usageGuideCache.set(dep.name, { guide, fetchedAt: now });
        }
      } catch {
        // Skip objects that fail to respond
      }
    });

    await Promise.all(promises);
    return guides;
  }

  /** Format dependencies and usage guides into markdown sections for the enriched prompt. */
  private formatEnrichedContext(
    deps: SelectedDependency[],
    usageGuides: Map<string, string>
  ): string {
    if (deps.length === 0) return '';

    return deps
      .map((dep) => {
        let text = `## ${dep.name}\n${dep.description}`;
        const guide = usageGuides.get(dep.name);
        if (guide) {
          text += `\n\n### Usage Guide (from ${dep.name} itself):\n${guide}`;
        }
        return text;
      })
      .join('\n\n---\n\n');
  }

  /** Orchestrator: runs the full discovery pipeline. Returns enriched context or '' on failure. */
  private async runDiscoveryPipeline(userText: string): Promise<string> {
    try {
      // Phase 0a: Get summaries
      const summaries = await this.discoverObjectSummaries();
      if (summaries.length === 0) return '';

      // Phase 0b: LLM selects relevant objects
      const selectedNames = await this.llmSelectRelevantObjects(userText, summaries);
      if (selectedNames.length === 0) return '';

      // Phase 0c: Fetch full manifests
      const deps = await this.fetchFullManifests(selectedNames, summaries);
      if (deps.length === 0) return '';

      // Phase 0c5: Generate targeted questions
      const questions = await this.generateTargetedQuestions(userText, deps);

      // Phase 0d: Fetch usage guides (parallel, cached)
      const guides = await this.fetchUsageGuides(deps, questions);

      // Format enriched context
      return this.formatEnrichedContext(deps, guides);
    } catch {
      // Graceful degradation — return empty string so Pass 1 results are used
      return '';
    }
  }

  private buildLLMMessages(useEnrichedContext = false): { role: string; content: string }[] {
    const systemPrompt = this.buildSystemPrompt(useEnrichedContext);
    const messages: { role: string; content: string }[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add recent conversation history (trimmed to avoid context overflow)
    const recent = this.conversationHistory.slice(-MAX_CONVERSATION_ENTRIES);
    for (const entry of recent) {
      messages.push({ role: entry.role, content: entry.content });
    }

    return messages;
  }

  private buildSystemPrompt(useEnrichedContext = false): string {
    return `You are Chat Agent, a helpful assistant inside the Abjects system. You help users explore, create, and control objects.

## Response Format

Always respond with a JSON object inside a \`\`\`json code block:

\`\`\`json
{
  "reply": "Your conversational response to the user.",
  "steps": [
    {
      "description": "Short human-readable description of this step",
      "code": "const result = await call(await dep('Registry'), 'abjects:registry', 'list', {}); return result;"
    }
  ]
}
\`\`\`

- **reply** (required): Your conversational response. Keep it concise.
- **steps** (optional): Array of code execution steps. Omit if just chatting.

## Code API

Inside step code, these functions are available:
- \`call(objectId, interfaceId, method, payload)\` — Send a request to an object. Returns the result.
- \`dep(name)\` — Find a dependency by manifest name (throws if not found). Returns AbjectId.
- \`find(name)\` — Find a dependency by manifest name (returns null if not found). Returns AbjectId or null.
- \`id\` — The JobManager's own AbjectId.
- \`previousResult\` — The return value from the previous step (undefined for the first step).

All code runs inside an async IIFE. Use \`await\` freely. Always \`return\` the result you want to pass to the next step.

## When to Use Steps

- Use steps when the user asks you to DO something (create objects, query registry, send messages, show/hide windows)
- Do NOT use steps for simple conversation, greetings, or explanations
- Each step should be self-contained and have a clear description

## Key Patterns

### Query the registry
\`\`\`
const objects = await call(await dep('Registry'), 'abjects:registry', 'list', {});
return objects.map(o => o.manifest.name + ': ' + o.manifest.description);
\`\`\`

### Describe an object
\`\`\`
const regId = await dep('Registry');
const results = await call(regId, 'abjects:registry', 'discover', { name: 'ObjectWorkshop' });
if (results.length > 0) {
  const desc = await call(results[0].id, 'abjects:introspect', 'describe', {});
  return desc;
}
return null;
\`\`\`

### Show/hide a window
\`\`\`
const results = await call(await dep('Registry'), 'abjects:registry', 'discover', { name: 'RegistryBrowser' });
if (results.length > 0) {
  await call(results[0].id, 'abjects:registry-browser', 'show', {});
}
return true;
\`\`\`

### Create a new object
\`\`\`
const creatorId = await dep('ObjectCreator');
const result = await call(creatorId, 'abjects:object-creator', 'create', { prompt: 'a simple counter widget' });
return result;
\`\`\`

### Send a message to any object
\`\`\`
const results = await call(await dep('Registry'), 'abjects:registry', 'discover', { name: 'SomeName' });
if (results.length > 0) {
  const r = await call(results[0].id, 'some:interface', 'someMethod', { key: 'value' });
  return r;
}
return 'Object not found';
\`\`\`

## Available Objects (Summary)

${this.objectSummaries || '(Loading...)'}
${useEnrichedContext && this.enrichedObjectContext ? `
## Detailed Guides for Relevant Objects

${this.enrichedObjectContext}
` : ''}
## Important Rules

1. Always respond with valid JSON in a \`\`\`json block
2. If you cannot parse or understand the request, just reply with no steps
3. Never generate infinite loops or recursive calls
4. Keep code concise — each step should do one thing
5. When step results come back, summarize them for the user in your follow-up reply`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Response Parsing
  // ═══════════════════════════════════════════════════════════════════

  private parseAgentResponse(content: string): AgentResponse {
    // Try to extract JSON from ```json ... ``` block
    const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[1].trim());
        return {
          reply: typeof parsed.reply === 'string' ? parsed.reply : content,
          steps: Array.isArray(parsed.steps) ? parsed.steps : undefined,
        };
      } catch {
        // JSON parse failed — fall through
      }
    }

    // Try parsing the whole content as JSON
    try {
      const parsed = JSON.parse(content);
      if (typeof parsed.reply === 'string') {
        return {
          reply: parsed.reply,
          steps: Array.isArray(parsed.steps) ? parsed.steps : undefined,
        };
      }
    } catch {
      // Not JSON — use as plain text reply
    }

    // Fallback: treat entire content as plain text reply
    return { reply: content, steps: undefined };
  }

  // ═══════════════════════════════════════════════════════════════════
  // UI Helpers
  // ═══════════════════════════════════════════════════════════════════

  private async appendMessageLabel(prefix: string, text: string, color: string): Promise<AbjectId> {
    if (!this.messageLogId || !this.windowId) return '' as AbjectId;

    const displayText = prefix ? `${prefix}: ${text}` : text;
    const r0 = { x: 0, y: 0, width: 0, height: 0 };
    const labelId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, WIDGETS_INTERFACE, 'createLabel', {
        windowId: this.windowId,
        rect: r0,
        text: displayText,
        style: { color, fontSize: 13 },
      })
    );
    await this.request(request(this.id, this.messageLogId, LAYOUT_INTERFACE, 'addLayoutChild', {
      widgetId: labelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: 20 },
    }));
    this.messageLabelIds.push(labelId);
    return labelId;
  }

  private async updateLabel(labelId: AbjectId, text: string, color: string): Promise<void> {
    if (!labelId) return;
    try {
      await this.request(
        request(this.id, labelId, WIDGET_INTERFACE, 'update', {
          text,
          style: { color, fontSize: 13 },
        })
      );
    } catch { /* label may be gone */ }
  }

  private async removeLabel(labelId: AbjectId): Promise<void> {
    if (!labelId || !this.messageLogId) return;
    try {
      await this.request(request(this.id, this.messageLogId, LAYOUT_INTERFACE, 'removeLayoutChild', {
        widgetId: labelId,
      }));
    } catch { /* may already be gone */ }
    try {
      await this.request(request(this.id, labelId, WIDGET_INTERFACE, 'destroy', {}));
    } catch { /* already gone */ }

    const idx = this.messageLabelIds.indexOf(labelId);
    if (idx >= 0) this.messageLabelIds.splice(idx, 1);
  }

  private async clearMessageLabels(): Promise<void> {
    if (!this.messageLogId) return;
    for (const labelId of this.messageLabelIds) {
      try {
        await this.request(request(this.id, this.messageLogId, LAYOUT_INTERFACE, 'removeLayoutChild', {
          widgetId: labelId,
        }));
      } catch { /* may already be gone */ }
      try {
        await this.request(request(this.id, labelId, WIDGET_INTERFACE, 'destroy', {}));
      } catch { /* already gone */ }
    }
    this.messageLabelIds = [];
  }
}

export const CHAT_ID = 'abjects:chat' as AbjectId;
