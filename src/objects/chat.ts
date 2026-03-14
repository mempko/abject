/**
 * Chat — conversational LLM agent.
 *
 * Provides a chat window where users type natural language requests.
 * Registers with AgentAbject as an agent — AgentAbject drives the
 * think-act-observe state machine, calling back Chat for observe and act.
 */

import { AbjectId, AbjectManifest, AbjectMessage, InterfaceId, ObjectRegistration } from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request } from '../core/message.js';
import { Capabilities } from '../core/capability.js';
import { formatManifestAsDescription } from '../core/introspect.js';
import type { AgentAction } from './agent-abject.js';
import type { DiscoveredWorkspace } from './workspace-share-registry.js';
import { estimateWrappedLineCount } from './widgets/word-wrap.js';

const CHAT_INTERFACE: InterfaceId = 'abjects:chat';

const WIN_W = 500;
const WIN_H = 500;
const MAX_CONVERSATION_ENTRIES = 40;
const MAX_STEPS = 20;

// ─── Chat-specific types ─────────────────────────────────────────────

interface ConversationEntry {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface ObjectSummary {
  id: AbjectId;
  name: string;
  description: string;
}

type UiPhase = 'closed' | 'idle' | 'busy';

export class Chat extends Abject {
  private widgetManagerId?: AbjectId;
  private registryId?: AbjectId;
  private agentAbjectId?: AbjectId;

  // Window/widget IDs
  private windowId?: AbjectId;
  private rootLayoutId?: AbjectId;
  private messageLogId?: AbjectId;
  private inputRowId?: AbjectId;
  private textInputId?: AbjectId;
  private sendBtnId?: AbjectId;

  private messageLabelIds: AbjectId[] = [];
  private conversationHistory: ConversationEntry[] = [];
  private userObjectSummaries = '';
  private systemObjectSummaries = '';
  private remotePeerContext = '';
  private uiPhase: UiPhase = 'closed';

  /** Label ID for the current "Thinking..." indicator. */
  private thinkingLabelId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'Chat',
        description:
          'Conversational LLM agent. Chat naturally to explore, create, and control objects. Uses a think-act-observe loop with structured actions.',
        version: '1.0.0',
        interface: {
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
    this.widgetManagerId = await this.requireDep('WidgetManager');
    this.registryId = await this.requireDep('Registry');
    this.agentAbjectId = await this.requireDep('AgentAbject');

    // Register with AgentAbject
    await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
      name: 'Chat',
      description: 'Conversational LLM agent for interacting with objects',
      config: {
        pinnedMessageCount: 1,
        terminalActions: {
          done: { type: 'success', resultFields: ['text', 'result', 'reasoning'] },
          fail: { type: 'error', resultFields: ['reason'] },
        },
        intermediateActions: ['reply'],
        skipFirstObservation: true,
      },
    }));
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
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
        phase: this.uiPhase,
        messageCount: this.conversationHistory.length,
        visible: !!this.windowId,
      };
    });

    this.on('clearHistory', async () => {
      this.conversationHistory = [];
      if (this.windowId) {
        await this.clearMessageLabels();
        await this.appendMessageLabel('Agent', 'How can I help you?', '#a8cc8c');
      }
      return true;
    });

    this.on('windowCloseRequested', async () => { await this.hide(); });

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

      if (fromId === this.textInputId && aspect === 'resize') {
        const { preferredHeight } = (msg.payload as { aspect: string; value: { preferredHeight: number } }).value;
        // Update text input height in HBox
        try {
          await this.request(request(this.id, this.inputRowId!, 'updateLayoutChild', {
            widgetId: this.textInputId,
            preferredSize: { height: preferredHeight },
          }));
          // Update input row height in root VBox
          await this.request(request(this.id, this.rootLayoutId!, 'updateLayoutChild', {
            widgetId: this.inputRowId,
            preferredSize: { height: preferredHeight },
          }));
        } catch { /* layout may be gone */ }
        return;
      }
    });

    // ── AgentAbject callback handlers ──

    this.on('agentObserve', async (_msg: AbjectMessage) => {
      const lines: string[] = [];
      if (this.userObjectSummaries) {
        lines.push('Your objects (user-created — use "modify" to update):');
        lines.push(this.userObjectSummaries);
      }
      if (this.systemObjectSummaries) {
        lines.push('');
        lines.push('System objects (built-in):');
        lines.push(this.systemObjectSummaries);
      }
      if (this.remotePeerContext) {
        lines.push('');
        lines.push('Connected peers:');
        lines.push(this.remotePeerContext);
      }
      return { observation: lines.join('\n') || 'No objects available.' };
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      const { action } = msg.payload as { taskId: string; step: number; action: AgentAction };
      return this.handleAgentAct(action);
    });

    this.on('agentPhaseChanged', async (msg: AbjectMessage) => {
      const { step, newPhase, action } =
        msg.payload as { taskId: string; step: number; oldPhase: string; newPhase: string; action?: string };

      // Update UI thinking label
      if (this.thinkingLabelId) {
        if (newPhase === 'thinking') {
          this.updateLabel(this.thinkingLabelId, `Thinking... (step ${step + 1})`, '#6b7084').catch(() => {});
        } else if (newPhase === 'acting' && action) {
          this.updateLabel(this.thinkingLabelId, `  ▸ ${action}...`, '#e8a84c').catch(() => {});
        }
      }
    });

    this.on('agentIntermediateAction', async (msg: AbjectMessage) => {
      const { action } = msg.payload as { taskId: string; action: AgentAction };

      // Handle 'reply' intermediate action — show text in UI, clear thinking label
      if (action.action === 'reply') {
        const text = (action.text as string) ?? '';
        if (text && this.thinkingLabelId) {
          await this.removeLabel(this.thinkingLabelId);
          await this.appendMessageLabel('Agent', text, '#a8cc8c');
          this.thinkingLabelId = undefined;
          // Re-show thinking indicator for next step
          this.thinkingLabelId = await this.appendMessageLabel('', 'Thinking...', '#6b7084');
        }
      }
    });

    this.on('agentActionResult', async (msg: AbjectMessage) => {
      const { action, result } =
        msg.payload as { taskId: string; action: AgentAction; result: { success: boolean; error?: string } };

      // Update UI with action result
      if (this.thinkingLabelId) {
        const desc = action?.reasoning ?? action?.action ?? '';
        if (result.success) {
          this.updateLabel(this.thinkingLabelId, `  ✓ ${desc}`, '#6b7084').catch(() => {});
        } else {
          this.updateLabel(this.thinkingLabelId, `  ✗ ${desc}`, '#e05561').catch(() => {});
        }
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Agent act handler
  // ═══════════════════════════════════════════════════════════════════

  private async handleAgentAct(action: AgentAction): Promise<unknown> {
    switch (action.action) {
      case 'list': {
        const objects = await this.request<ObjectRegistration[]>(
          request(this.id, this.registryId!, 'list', {})
        );
        return {
          success: true,
          data: objects.map(o => ({
            name: o.manifest.name,
            description: o.manifest.description,
            id: o.id,
          })),
        };
      }

      case 'introspect': {
        const objectId = await this.resolveObject(action.object as string);
        if (!objectId) return { success: false, error: `Object "${action.object}" not found` };
        const result = await this.request<{ manifest: AbjectManifest; description: string }>(
          request(this.id, objectId, 'describe', {})
        );
        return { success: true, data: result };
      }

      case 'ask': {
        const objectId = await this.resolveObject(action.object as string);
        if (!objectId) return { success: false, error: `Object "${action.object}" not found` };
        const answer = await this.request<string>(
          request(this.id, objectId, 'ask', { question: action.question as string }),
          60000
        );
        return { success: true, data: answer };
      }

      case 'call': {
        const targetStr = action.object as string;
        const objectId = await this.resolveObject(targetStr);
        if (!objectId) return { success: false, error: `Object "${targetStr}" not found` };

        const method = action.method as string;
        const timeout = method === 'runTask' || method === 'create' ? 310000 : 120000;
        try {
          const result = await this.request(
            request(this.id, objectId, method, action.payload ?? {}),
            timeout,
          );
          return { success: true, data: result };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'create': {
        const creatorId = await this.discoverDep('ObjectCreator');
        if (!creatorId) return { success: false, error: 'ObjectCreator not found' };
        try {
          const result = await this.request(
            request(this.id, creatorId, 'create', { prompt: action.description as string }),
            310000,
          );
          return { success: true, data: result };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'modify': {
        const creatorId = await this.discoverDep('ObjectCreator');
        if (!creatorId) return { success: false, error: 'ObjectCreator not found' };
        const objectId = await this.resolveObject(action.object as string);
        if (!objectId) return { success: false, error: `Object "${action.object}" not found` };
        try {
          const result = await this.request(
            request(this.id, creatorId, 'modify', {
              objectId,
              prompt: action.description as string,
            }),
            310000,
          );
          return { success: true, data: result };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'clone': {
        // Clone a clonable object (local or remote) — Factory searches all registries
        const qualifiedName = action.object as string;
        if (!qualifiedName) return { success: false, error: 'Missing object name or qualified name (peer.workspace.ObjectName)' };

        try {
          // Resolve qualified name to an AbjectId via remote registry listing
          const parts = qualifiedName.split('.');
          let objectId: AbjectId | null = null;
          let objectName = qualifiedName;

          if (parts.length >= 3) {
            // Qualified name: peer.workspace.ObjectName
            const peerName = parts[0];
            const wsName = parts[1];
            objectName = parts.slice(2).join('.');

            const wsrId = await this.discoverDep('WorkspaceShareRegistry');
            if (!wsrId) return { success: false, error: 'WorkspaceShareRegistry not found' };

            const workspaces = await this.request<DiscoveredWorkspace[]>(
              request(this.id, wsrId, 'getDiscoveredWorkspaces', {})
            );
            const ws = workspaces.find(w => w.ownerName === peerName && w.name === wsName);
            if (!ws) return { success: false, error: `Workspace "${peerName}.${wsName}" not found in discovered workspaces` };

            const remoteObjects = await this.request<ObjectRegistration[]>(
              request(this.id, ws.registryId as AbjectId, 'list', {})
            );
            const target = remoteObjects.find(o => (o.name ?? o.manifest.name) === objectName);
            if (!target) return { success: false, error: `Object "${objectName}" not found in ${peerName}.${wsName}` };
            objectId = target.id;
          } else {
            // Simple name or AbjectId — resolve locally
            objectId = await this.resolveObject(qualifiedName);
          }

          if (!objectId) return { success: false, error: `Object "${qualifiedName}" not found` };

          // Factory.clone searches local then remote registries automatically
          const factoryId = await this.requireDep('Factory');
          const result = await this.request<{ objectId: AbjectId }>(
            request(this.id, factoryId, 'clone', { objectId, registryHint: this.registryId })
          );

          // Persist to AbjectStore so it survives reload
          try {
            const storeResults = await this.request<Array<{ id: AbjectId }>>(
              request(this.id, this.registryId!, 'discover', { name: 'AbjectStore' })
            );
            if (storeResults.length > 0) {
              // Look up the freshly cloned object's registration for manifest/source
              const reg = await this.request<ObjectRegistration | null>(
                request(this.id, this.registryId!, 'lookup', { objectId: result.objectId })
              );
              if (reg?.source) {
                await this.request(request(this.id, storeResults[0].id, 'save', {
                  objectId: result.objectId,
                  manifest: reg.manifest,
                  source: reg.source,
                  owner: this.id,
                }));
              }
            }
          } catch { /* AbjectStore may not exist */ }

          return { success: true, data: { clonedObjectId: result.objectId, name: objectName } };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      case 'delegate': {
        // Delegate a task to another registered agent
        try {
          const agents = await this.request<Array<{ agentId: AbjectId; name: string }>>(
            request(this.id, this.agentAbjectId!, 'listAgents', {})
          );
          const agent = agents.find(a => a.name === action.agent);
          if (!agent) return { success: false, error: `Agent "${action.agent}" not found` };
          const result = await this.request(
            request(this.id, this.agentAbjectId!, 'startTask', {
              agentId: agent.agentId,
              task: action.task as string,
              responseSchema: action.responseSchema as Record<string, unknown> | undefined,
            }),
            310000,
          );
          return { success: true, data: result };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      default:
        return { success: false, error: `Unknown action: ${action.action}` };
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // System prompt
  // ═══════════════════════════════════════════════════════════════════

  private buildSystemPrompt(): string {
    return `You are Chat Agent, a helpful assistant inside the Abjects system. You help users by interacting with objects via structured actions.

## System Architecture

Abjects is a distributed message-passing system. Each Abject is an autonomous object with a manifest (declaring methods and events), a mailbox, and message handlers. Objects communicate exclusively via messages — never direct calls. They discover each other via Registry and coordinate via the observer pattern (addDependent → changed events).

### Three UI Patterns

1. **Widget Objects** (forms, settings, dashboards): Standard UI controls — buttons, text inputs, labels, sliders, checkboxes, tabs, progress bars, images. Use WidgetManager to create windows with widget layouts.
2. **Canvas Surface Objects** (games, charts, custom graphics): Raw drawing via WidgetManager.createCanvas — shapes, text, images, gradients, transforms. Timer-driven animation.
3. **Web Automation** (interact with real websites): WebAgent drives a headless browser to navigate, fill forms, click, and extract data from real sites.

### When to Create vs Modify vs Call

- Use **create** when the user wants a brand-new object with its own window and behavior (e.g., "make me a todo app", "build a color picker"). ObjectCreator will design and generate it.
- Use **modify** when the user wants to **fix, change, or update** an existing object's behavior or appearance (e.g., "add a reset button to the counter", "fix the login button", "change the background color"). Always prefer modify over create when the object already exists.
- Use **call** to invoke existing objects directly (e.g., "fetch this URL", "set a timer", "run this web task"). Use **ask** first to learn the object's API.
- Use **ask** on any object to get usage guidance with code examples. This is how you discover APIs — don't guess method signatures.

### Observer & Composition Model

Objects observe each other via addDependent → changed events. Any object can inspect another via getState, describe, or ask. Objects with show/hide methods automatically appear in the Taskbar.

## Action Format

Respond with ONE action as a JSON object in a \`\`\`json code block. Include brief reasoning before the block.

\`\`\`json
{ "action": "done", "text": "Hello! How can I help you?" }
\`\`\`

## Available Actions

### Information
- **list**: List available objects. No params.
  \`{ "action": "list" }\`
- **introspect**: Get an object's manifest and description.
  \`{ "action": "introspect", "object": "ObjectName" }\`
- **ask**: Ask an object for usage advice.
  \`{ "action": "ask", "object": "ObjectName", "question": "How do I use your X method?" }\`

### Object Interaction
- **call**: Send a message to an object (message passing).
  \`{ "action": "call", "object": "ObjectName", "method": "methodName", "payload": { ... } }\`
  For "object" you can use a name (e.g. "Timer") or an AbjectId (e.g. "abjects:timer").
- **create**: Create a new object via ObjectCreator.
  \`{ "action": "create", "description": "A counter widget that shows a number and has +/- buttons" }\`
- **modify**: Modify an existing object via ObjectCreator.
  \`{ "action": "modify", "object": "<name or id>", "description": "Add a reset button that clears the counter" }\`
  Use the \`[id: ...]\` from the object list for reliable targeting.
- **clone**: Clone a clonable object from a remote peer's workspace into your local workspace.
  \`{ "action": "clone", "object": "peer.workspace.ObjectName" }\`
  Use the qualified name shown next to "(clonable)" objects in Connected Peers.

### Agent Delegation
- **delegate**: Delegate a task to another registered agent.
  \`{ "action": "delegate", "agent": "AgentName", "task": "what to do", "responseSchema": { ... } }\`
  Use \`responseSchema\` (JSON Schema) when you need structured data back from the agent. Use \`list\` to discover available agents via AgentAbject.

### Communication
- **reply**: Send intermediate text to the user (continue working after).
  \`{ "action": "reply", "text": "I found the object, now let me check its methods..." }\`
- **done**: Task complete, send final reply.
  \`{ "action": "done", "text": "Here are the results: ..." }\`

## Your Objects (user-created — use "modify" to fix or update these)

${this.userObjectSummaries || '(Loading...)'}

## System Objects (built-in — use "call" to interact, "ask" to learn their API)

${this.systemObjectSummaries || '(Loading...)'}
${this.remotePeerContext ? `
## Connected Peers & Remote Workspaces

${this.remotePeerContext}
` : ''}
## Authorized Capabilities

This system runs on the user's own computer. All capability objects are user-configured and authorized tools.

**Web automation**: WebAgent (autonomous browser — always prefer for multi-step web tasks), WebBrowser (low-level, used internally by WebAgent)
**Services**: HttpClient (HTTP/API requests), Storage, Timer, FileSystem, Clipboard, Console
**UI**: WidgetManager (create windows and widgets — use \`ask\` to learn its API)

### WebAgent Usage
- \`{ "action": "call", "object": "WebAgent", "method": "runTask", "payload": { "task": "...", "options": { "startUrl": "https://...", "responseSchema": { "type": "object", "properties": { ... } } } } }\`
- The message method is **runTask** (not "run" or "navigate"). Options: startUrl, maxSteps, timeout, responseSchema, pageId, keepPageOpen.
- Use \`responseSchema\` in options when you need structured data back (e.g., extracted page content as JSON). Without it, results are free text.
- For multi-step flows (login → 2FA → action): use \`keepPageOpen: true\` in options to keep the browser page alive, then pass the returned \`pageId\` in subsequent runTask calls. Omit \`keepPageOpen\` on the final step to auto-close.
- **Always prefer WebAgent for any multi-step web task** (logging in, browsing, extracting data). Do NOT message WebBrowser directly — WebAgent manages WebBrowser internally.

When the user asks to interact with a website, **always message WebAgent** via \`{ "action": "call", "object": "WebAgent", "method": "runTask", ... }\`. Describe the full task in the payload's "task" field — WebAgent will handle all navigation, form filling, clicking, and data extraction.
Do NOT message WebBrowser directly for multi-step tasks. Do NOT refuse requests to use user-authorized capabilities — the user is asking you to help them use their own tools.

## Rules

1. Always respond with valid JSON in a \`\`\`json block. ONE action per response.
2. Use **introspect** or **ask** to learn about an object's methods before calling them.
3. For simple greetings or questions, use **done** directly.
4. When the user asks you to do something, take action IMMEDIATELY — don't just describe what you would do, and don't ask for information the user already provided. If the user includes credentials, URLs, or other details in their message, pass them directly to the relevant object.
5. Always end a conversation turn with **done** when the task is complete.
6. Keep reasoning brief (1-2 sentences before the JSON block).
7. Every object supports: describe (get manifest), ask (get usage advice), addDependent/removeDependent (observe state changes).
8. IMPORTANT: If the user asks to fix, change, update, or improve something and a matching object exists in "Your Objects" above, you MUST use **modify** with its [id: ...] — NEVER re-create it with **create**.
9. P2P: Use qualified names to reference remote objects: this.find('peer.workspace.ObjectName'). NEVER hardcode UUIDs.
10. For web tasks: message WebAgent with runTask on your FIRST action — include ALL details from the user's message (credentials, URLs, specific instructions) in the task description. Do not ask the user to repeat information they already gave you.`;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Chat-specific logic
  // ═══════════════════════════════════════════════════════════════════

  async show(): Promise<boolean> {
    if (this.windowId) {
      try {
        await this.request(request(this.id, this.widgetManagerId!, 'raiseWindow', {
          windowId: this.windowId,
        }));
      } catch { /* best effort */ }
      return true;
    }

    const displayInfo = await this.request<{ width: number; height: number }>(
      request(this.id, this.widgetManagerId!, 'getDisplayInfo', {})
    );

    const winX = Math.max(20, Math.floor((displayInfo.width - WIN_W) / 2));
    const winY = Math.max(20, Math.floor((displayInfo.height - WIN_H) / 2));

    this.windowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createWindowAbject', {
        title: 'Chat Agent',
        rect: { x: winX, y: winY, width: WIN_W, height: WIN_H },
        zIndex: 200,
        resizable: true,
      })
    );

    // Root VBox
    this.rootLayoutId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createVBox', {
        windowId: this.windowId,
        margins: { top: 8, right: 16, bottom: 8, left: 16 },
        spacing: 6,
      })
    );

    // Scrollable VBox for message log (expanding)
    this.messageLogId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedScrollableVBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 4,
      })
    );

    // Input row (HBox: TextInput + Send button)
    this.inputRowId = await this.request<AbjectId>(
      request(this.id, this.widgetManagerId!, 'createNestedHBox', {
        parentLayoutId: this.rootLayoutId,
        margins: { top: 0, right: 0, bottom: 0, left: 0 },
        spacing: 8,
      })
    );

    // Add layouts to root
    await this.request(request(this.id, this.rootLayoutId, 'addLayoutChildren', {
      children: [
        { widgetId: this.messageLogId, sizePolicy: { vertical: 'expanding', horizontal: 'expanding' } },
        { widgetId: this.inputRowId, sizePolicy: { vertical: 'preferred', horizontal: 'expanding' }, preferredSize: { height: 36 } },
      ],
    }));

    // Batch create text input + send button
    const { widgetIds } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'textInput', windowId: this.windowId, placeholder: 'Type a message...', wordWrap: true, maxLines: 6 },
          { type: 'button', windowId: this.windowId, text: 'Send', style: { background: '#e8a84c', color: '#0f1019', borderColor: '#e8a84c' } },
        ],
      })
    );
    this.textInputId = widgetIds[0];
    this.sendBtnId = widgetIds[1];

    // Batch add to input row
    await this.request(request(this.id, this.inputRowId, 'addLayoutChildren', {
      children: [
        { widgetId: this.textInputId, sizePolicy: { horizontal: 'expanding' }, preferredSize: { height: 36 } },
        { widgetId: this.sendBtnId, sizePolicy: { horizontal: 'fixed' }, preferredSize: { width: 60, height: 36 } },
      ],
    }));

    // Fire-and-forget: register as dependent of interactive widgets
    this.send(request(this.id, this.sendBtnId, 'addDependent', {}));
    this.send(request(this.id, this.textInputId, 'addDependent', {}));

    this.uiPhase = 'idle';

    // Show greeting
    await this.appendMessageLabel('Agent', 'How can I help you?', '#a8cc8c');

    await this.changed('visibility', true);
    return true;
  }

  async hide(): Promise<boolean> {
    if (!this.windowId) return true;

    this.uiPhase = 'closed';

    await this.request(
      request(this.id, this.widgetManagerId!, 'destroyWindowAbject', {
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
    await this.changed('visibility', false);
    return true;
  }

  private async handleSendClick(): Promise<void> {
    if (this.uiPhase !== 'idle' || !this.textInputId) return;

    const text = await this.request<string>(
      request(this.id, this.textInputId, 'getValue', {})
    );

    if (!text?.trim()) return;

    // Clear input
    await this.request(
      request(this.id, this.textInputId, 'update', { text: '' })
    );

    this.triggerSend(text.trim());
  }

  private triggerSend(text: string): void {
    if (this.uiPhase !== 'idle') return;
    this.runChatTask(text);
  }

  private async runChatTask(userText: string): Promise<void> {
    if (this.uiPhase === 'closed') return;
    this.uiPhase = 'busy';
    await this.setInputDisabled(true);

    // Show user message
    await this.appendMessageLabel('You', userText, '#e2e4e9');
    this.conversationHistory.push({ role: 'user', content: userText });

    // Show thinking indicator
    this.thinkingLabelId = await this.appendMessageLabel('', 'Thinking...', '#6b7084');

    try {
      // Refresh object summaries for the system prompt
      await this.refreshObjectSummaries();

      // Build initial messages: system prompt + conversation history + new user message
      const initialMessages: { role: string; content: string }[] = [];
      const recent = this.conversationHistory.slice(-MAX_CONVERSATION_ENTRIES);
      for (const entry of recent) {
        initialMessages.push({ role: entry.role, content: entry.content });
      }

      const result = await this.request<{
        taskId: string;
        success: boolean;
        result?: unknown;
        error?: string;
        steps: number;
      }>(
        request(this.id, this.agentAbjectId!, 'startTask', {
          task: userText,
          systemPrompt: this.buildSystemPrompt(),
          initialMessages,
          config: { queueName: `chat-${this.id}` },
        }),
        310000,
      );

      // Post-task UI cleanup
      if (this.thinkingLabelId) {
        if (result.success) {
          await this.removeLabel(this.thinkingLabelId);
          const text = (result.result as string) ?? '';
          if (text) {
            await this.appendMessageLabel('Agent', text, '#a8cc8c');
            this.conversationHistory.push({ role: 'assistant', content: text });
          }
        } else {
          await this.removeLabel(this.thinkingLabelId);
          await this.appendMessageLabel('Error', (result.error ?? 'Unknown error').slice(0, 100), '#e05561');
        }
        this.thinkingLabelId = undefined;
      }
    } catch (err) {
      // Remove thinking indicator if still there
      if (this.thinkingLabelId) {
        await this.removeLabel(this.thinkingLabelId);
        this.thinkingLabelId = undefined;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.appendMessageLabel('Error', errMsg.slice(0, 100), '#e05561');
    }

    this.uiPhase = this.windowId ? 'idle' : 'closed';
    if (this.windowId) await this.setInputDisabled(false);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Object Resolution
  // ═══════════════════════════════════════════════════════════════════

  private async resolveObject(name: string): Promise<AbjectId | null> {
    if (!this.registryId || !name) return null;

    // UUIDs are direct AbjectIds — use as-is
    if (name.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      return name as AbjectId;
    }

    // Everything else (names like "WebAgent", interface IDs like "abjects:web-agent")
    // gets resolved via Registry discovery
    try {
      const results = await this.request<Array<{ id: AbjectId }>>(
        request(this.id, this.registryId, 'discover', { name })
      );
      return results.length > 0 ? results[0].id : null;
    } catch {
      return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Context Refresh
  // ═══════════════════════════════════════════════════════════════════

  private async refreshObjectSummaries(): Promise<void> {
    if (this.userObjectSummaries && this.conversationHistory.length < 5) return;

    try {
      const objects = await this.request<ObjectRegistration[]>(
        request(this.id, this.registryId!, 'list', {})
      );

      const userObjects = objects.filter(obj => !(obj.manifest.tags ?? []).includes('system'));
      const systemObjects = objects.filter(obj => (obj.manifest.tags ?? []).includes('system'));

      this.userObjectSummaries = userObjects.length > 0
        ? userObjects.map(obj => `[id: ${obj.id}]\n${formatManifestAsDescription(obj.manifest)}`).join('\n\n---\n\n')
        : '(None yet — use **create** to build something new)';

      this.systemObjectSummaries = systemObjects
        .map(obj => `- ${obj.manifest.name} — ${obj.manifest.description}`)
        .join('\n');
    } catch {
      // Keep existing summaries if refresh fails
    }

    await this.refreshRemotePeerContext();
  }

  private async refreshRemotePeerContext(): Promise<void> {
    try {
      const wsrId = await this.discoverDep('WorkspaceShareRegistry');
      if (!wsrId) return;

      let workspaces = await this.request<DiscoveredWorkspace[]>(
        request(this.id, wsrId, 'getDiscoveredWorkspaces', {})
      );

      if (workspaces.length === 0) {
        workspaces = await this.request<DiscoveredWorkspace[]>(
          request(this.id, wsrId, 'discoverWorkspaces', { hops: 1 })
        );
      }

      if (workspaces.length === 0) {
        this.remotePeerContext = '';
        return;
      }

      const lines: string[] = [];
      for (const ws of workspaces) {
        try {
          const remoteObjects = await this.request<ObjectRegistration[]>(
            request(this.id, ws.registryId as AbjectId, 'list', {})
          );
          const objNames = remoteObjects.map(o => {
            const clonable = (o as ObjectRegistration & { source?: string }).source ? ' (clonable)' : '';
            const displayName = o.name ?? o.manifest.name;
            const qualified = `${ws.ownerName}.${ws.name}.${displayName}`;
            return `${displayName} → find('${qualified}')${clonable}`;
          }).join(', ');
          lines.push(`- Peer "${ws.ownerName}" workspace "${ws.name}" (registryId: ${ws.registryId})\n  Objects: ${objNames}`);
        } catch {
          lines.push(`- Peer "${ws.ownerName}" workspace "${ws.name}" (registryId: ${ws.registryId})\n  Objects: (could not query)`);
        }
      }
      this.remotePeerContext = lines.join('\n');
      if (lines.length > 0) {
        this.remotePeerContext += "\n\nGenerated code should use this.find('peer.workspace.ObjectName') — never hardcode UUIDs. To copy a clonable object locally, use the clone action.";
      }
    } catch {
      // Best-effort — leave remotePeerContext unchanged
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // UI Helpers
  // ═══════════════════════════════════════════════════════════════════

  private async setInputDisabled(disabled: boolean): Promise<void> {
    const style = { disabled };
    if (this.sendBtnId) {
      try { await this.request(request(this.id, this.sendBtnId, 'update', { style })); } catch { /* widget gone */ }
    }
    if (this.textInputId) {
      try { await this.request(request(this.id, this.textInputId, 'update', { style })); } catch { /* widget gone */ }
    }
  }

  private async appendMessageLabel(prefix: string, text: string, color: string): Promise<AbjectId> {
    if (!this.messageLogId || !this.windowId) return '' as AbjectId;

    const displayText = prefix ? `${prefix}: ${text}` : text;
    const fontSize = 13;
    const lineHeight = fontSize + 4;
    const availableWidth = WIN_W - 32 - 8; // margins + scrollbar
    const lineCount = estimateWrappedLineCount(displayText, availableWidth, fontSize);
    const estimatedHeight = Math.max(20, lineCount * lineHeight + 4);

    const { widgetIds: [labelId] } = await this.request<{ widgetIds: AbjectId[] }>(
      request(this.id, this.widgetManagerId!, 'create', {
        specs: [
          { type: 'label', windowId: this.windowId, text: displayText, style: { color, fontSize, wordWrap: true } },
        ],
      })
    );
    await this.request(request(this.id, this.messageLogId, 'addLayoutChild', {
      widgetId: labelId,
      sizePolicy: { vertical: 'fixed' },
      preferredSize: { height: estimatedHeight },
    }));
    this.messageLabelIds.push(labelId);
    return labelId;
  }

  private async updateLabel(labelId: AbjectId, text: string, color: string): Promise<void> {
    if (!labelId) return;
    try {
      await this.request(
        request(this.id, labelId, 'update', {
          text,
          style: { color, fontSize: 13, wordWrap: true },
        })
      );
    } catch { /* label may be gone */ }
  }

  private async removeLabel(labelId: AbjectId): Promise<void> {
    if (!labelId || !this.messageLogId) return;
    try {
      await this.request(request(this.id, this.messageLogId, 'removeLayoutChild', {
        widgetId: labelId,
      }));
    } catch { /* may already be gone */ }
    try {
      await this.request(request(this.id, labelId, 'destroy', {}));
    } catch { /* already gone */ }

    const idx = this.messageLabelIds.indexOf(labelId);
    if (idx >= 0) this.messageLabelIds.splice(idx, 1);
  }

  private async clearMessageLabels(): Promise<void> {
    if (!this.messageLogId) return;

    // Clear layout in one request
    try {
      await this.request(request(this.id, this.messageLogId, 'clearLayoutChildren', {}));
    } catch { /* may already be gone */ }

    // Fire-and-forget destroy all labels
    for (const labelId of this.messageLabelIds) {
      this.send(request(this.id, labelId, 'destroy', {}));
    }
    this.messageLabelIds = [];
  }

  protected override getSourceForAsk(): string | undefined {
    return `## Chat Usage Guide

### Send a message programmatically

  await call(await dep('Chat'), 'sendMessage', { message: 'Hello, what can you do?' });
  // The Chat agent processes the message through its observe-think-act loop

### Show / hide the Chat window

  await call(await dep('Chat'), 'show', {});
  await call(await dep('Chat'), 'hide', {});

### Get current state

  const state = await call(await dep('Chat'), 'getState', {});
  // state: { visible, messageCount, ... }

### Clear conversation history

  await call(await dep('Chat'), 'clearHistory', {});

### IMPORTANT
- The interface ID is 'abjects:chat'.
- Chat is an agent — it uses AgentAbject's observe-think-act loop to process messages.
- sendMessage triggers the full agent cycle: the LLM decides what actions to take.
- Actions can include creating objects, calling other services, or replying with text.`;
  }
}

export const CHAT_ID = 'abjects:chat' as AbjectId;
