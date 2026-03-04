/**
 * Object Creator - user-facing object for creating and modifying objects via natural language.
 *
 * Uses a multi-phase pipeline:
 *   Phase 0a: discoverObjectSummaries() — registry.list() → name + description
 *   Phase 0b: llmSelectDependencies()   — LLM picks relevant objects from summaries
 *   Phase 0c: fetchFullManifests()       — registry.lookup() for selected objects
 *   Phase 0c5: generateTargetedQuestions() — LLM generates goal-specific questions per dep
 *   Phase 0d: fetchUsageGuides()         — ask each dep with targeted (or generic) questions
 *   Phase 1:  generateManifest()         — LLM designs manifest with full dependency context
 *   Phase 2:  generateHandlerCode()      — LLM generates this.call() code
 *   Phase 3:  verifyAndFix()             — programmatic consistency check
 *   Phase 3b: llmVerifyAndFix()          — optional LLM-assisted fix
 *   Phase 4:  compile check
 *   Phase 5:  factory.spawn()
 *   Phase 5b: probeObject()              — validate deps referenced in source resolve
 *   Phase 5c: retryWithProbeFeedback()   — re-select deps, regenerate code, apply fix (up to 2 retries)
 *   Phase 6:  negotiator.connect()       — optional, connects to deps
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  InterfaceId,
  ObjectRegistration,
  SpawnRequest,
  SpawnResult,
} from '../core/types.js';
import { Abject, DEFERRED_REPLY } from '../core/abject.js';
import { require } from '../core/contracts.js';
import { request, event } from '../core/message.js';
import { IntrospectResult } from '../core/introspect.js';

import { ScriptableAbject } from './scriptable-abject.js';
import { systemMessage, userMessage, LLMMessage, LLMCompletionResult, LLMCompletionOptions } from '../llm/provider.js';
import type { AgentAction } from './agent-abject.js';

/** Per-creation-task state for tracking agent-driven creation. */
interface CreationTaskExtra {
  prompt: string;
  context?: string;
  callerId?: AbjectId;
  deferredMsg: AbjectMessage;
  result?: CreationResult;
}


const OBJECT_CREATOR_INTERFACE = 'abjects:object-creator' as InterfaceId;

export interface CreateObjectRequest {
  prompt: string;
  context?: string;
}

export interface ModifyObjectRequest {
  objectId: AbjectId;
  prompt: string;
}

export interface CreationResult {
  success: boolean;
  objectId?: AbjectId;
  manifest?: AbjectManifest;
  code?: string;
  error?: string;
  usedObjects?: string[];
}

/** Summary of a registered object (name + description only). */
interface ObjectSummary {
  id: AbjectId;
  name: string;
  description: string;
}

/** A dependency selected by the LLM, with its full manifest and description. */
interface SelectedDependency {
  id: AbjectId;
  name: string;
  manifest: AbjectManifest;
  description: string;
}

/**
 * The Object Creator allows users to create objects via natural language prompts.
 */
export class ObjectCreator extends Abject {
  private llmId?: AbjectId;
  private registryId?: AbjectId;
  private systemRegistryId?: AbjectId;
  private factoryId?: AbjectId;
  private negotiatorId?: AbjectId;
  private abjectStoreId?: AbjectId;
  private widgetManagerId?: AbjectId;
  private agentAbjectId?: AbjectId;
  private _currentCallerId?: AbjectId;
  private creationTasks = new Map<string, CreationTaskExtra>();

  constructor() {
    super({
      manifest: {
        name: 'ObjectCreator',
        description:
          'Create and modify objects using natural language. Discovers existing objects and generates new ones that compose with them.',
        version: '1.0.0',
        interface: {
            id: OBJECT_CREATOR_INTERFACE,
            name: 'ObjectCreator',
            description: 'Object creation via natural language',
            methods: [
              {
                name: 'create',
                description: 'Create a new object from a description',
                parameters: [
                  {
                    name: 'prompt',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Natural language description of the object',
                  },
                  {
                    name: 'context',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Additional context',
                    optional: true,
                  },
                ],
                returns: { kind: 'reference', reference: 'CreationResult' },
              },
              {
                name: 'modify',
                description: 'Modify an existing object',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Object to modify',
                  },
                  {
                    name: 'prompt',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'What to change',
                  },
                ],
                returns: { kind: 'reference', reference: 'CreationResult' },
              },
              {
                name: 'suggest',
                description: 'Get suggestions for objects to create',
                parameters: [
                  {
                    name: 'context',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'What the user wants to achieve',
                  },
                ],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'primitive', primitive: 'string' },
                },
              },
              {
                name: 'listAvailable',
                description: 'List available objects for composition',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'ObjectRegistration' },
                },
              },
              {
                name: 'getObjectGraph',
                description: 'Get the object dependency graph',
                parameters: [],
                returns: {
                  kind: 'object',
                  properties: {
                    nodes: {
                      kind: 'array',
                      elementType: { kind: 'primitive', primitive: 'string' },
                    },
                    edges: {
                      kind: 'array',
                      elementType: {
                        kind: 'object',
                        properties: {
                          from: { kind: 'primitive', primitive: 'string' },
                          to: { kind: 'primitive', primitive: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            ],
            events: [
              {
                name: 'objectCreated',
                description: 'New object was created',
                payload: { kind: 'reference', reference: 'CreationResult' },
              },
              {
                name: 'objectModified',
                description: 'Object was modified',
                payload: { kind: 'reference', reference: 'CreationResult' },
              },
              {
                name: 'progress',
                description: 'Progress update during object creation',
                payload: {
                  kind: 'object',
                  properties: {
                    phase: { kind: 'primitive', primitive: 'string' },
                    message: { kind: 'primitive', primitive: 'string' },
                  },
                },
              },
            ],
          },
        requiredCapabilities: [],
        providedCapabilities: [],
        tags: ['system', 'ui', 'creation'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('create', async (msg: AbjectMessage) => {
      const { prompt, context } = msg.payload as CreateObjectRequest;

      // Route through AgentAbject if available — jobs become visible in JobBrowser
      if (this.agentAbjectId) {
        const taskId = `create-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        this.creationTasks.set(taskId, {
          prompt,
          context,
          callerId: msg.routing.from,
          deferredMsg: msg,
        });
        this.runCreationViaAgent(taskId);
        return DEFERRED_REPLY;
      }

      // Fallback: direct execution when AgentAbject is unavailable
      return this.createObject(prompt, context, msg.routing.from);
    });

    this.on('modify', async (msg: AbjectMessage) => {
      const { objectId, prompt } = msg.payload as ModifyObjectRequest;
      return this.modifyObject(objectId, prompt, msg.routing.from);
    });

    this.on('suggest', async (msg: AbjectMessage) => {
      const { context } = msg.payload as { context: string };
      return this.suggestObjects(context);
    });

    this.on('listAvailable', async () => {
      return this.listAvailableObjects();
    });

    this.on('getObjectGraph', async () => {
      return this.getObjectGraph();
    });

    // Forward LLM keep-alive progress events to the upstream caller
    this.on('progress', async (msg: AbjectMessage) => {
      if (this._currentCallerId) {
        const payload = msg.payload as { phase?: string; message?: string };
        await this.reportProgress(
          this._currentCallerId,
          payload.phase ?? 'llm',
          payload.message ?? 'LLM processing...'
        );
      }
    });

    // ── AgentAbject callback handlers (for delegation) ──

    this.on('agentObserve', async (msg: AbjectMessage) => {
      const { taskId } = msg.payload as { taskId: string; step: number };
      const extra = this.creationTasks.get(taskId);
      if (!extra) return { observation: 'ObjectCreator ready. Available actions: create_object (new object from prompt), modify_object (update existing object by ID).' };

      if (extra.result) {
        if (extra.result.success) {
          return {
            observation: `Creation complete. Object "${extra.result.manifest?.name ?? 'unknown'}" spawned as ${extra.result.objectId}. Dependencies: ${(extra.result.usedObjects ?? []).join(', ') || 'none'}.`,
          };
        }
        return { observation: `Creation failed: ${extra.result.error}` };
      }

      return { observation: `Task: "${extra.prompt}". Execute create_object to build it.` };
    });

    this.on('agentAct', async (msg: AbjectMessage) => {
      const { taskId, action } = msg.payload as { taskId: string; step: number; action: AgentAction };
      const extra = this.creationTasks.get(taskId);

      switch (action.action) {
        case 'create_object': {
          const prompt = extra?.prompt ?? (action.prompt ?? action.description ?? action.task) as string;
          if (!prompt) return { success: false, error: 'No prompt provided for create_object' };
          const context = extra?.context ?? (action.context as string | undefined);
          const result = await this.createObject(prompt, context, extra?.callerId ?? msg.routing.from);
          if (extra) extra.result = result;
          return { success: result.success, data: result, error: result.error };
        }
        case 'modify_object': {
          const objectId = action.objectId as string;
          const prompt = (action.prompt ?? action.description) as string;
          if (!objectId || !prompt) return { success: false, error: 'objectId and prompt required for modify_object' };
          const result = await this.modifyObject(objectId as AbjectId, prompt, msg.routing.from);
          return { success: result.success, data: result, error: result.error };
        }
        default:
          return { success: false, error: `Unknown action: ${action.action}` };
      }
    });

    this.on('agentPhaseChanged', async () => { /* no-op */ });
    this.on('agentIntermediateAction', async () => { /* no-op */ });
    this.on('agentActionResult', async () => { /* no-op */ });
  }

  protected override async onInit(): Promise<void> {
    this.llmId = await this.requireDep('LLM');
    this.registryId = await this.requireDep('Registry');
    this.factoryId = await this.requireDep('Factory');
    this.negotiatorId = await this.requireDep('Negotiator');
    this.abjectStoreId = await this.discoverDep('AbjectStore') ?? undefined;
    this.systemRegistryId = await this.discoverDep('SystemRegistry') ?? undefined;
    this.widgetManagerId = await this.discoverDep('WidgetManager') ?? undefined;
    this.agentAbjectId = await this.discoverDep('AgentAbject') ?? undefined;

    // Register as an agent for discoverability and delegation
    if (this.agentAbjectId) {
      try {
        await this.request(request(this.id, this.agentAbjectId, 'registerAgent', {
          name: 'ObjectCreator',
          description: 'Creates and modifies objects from natural language prompts',
          config: {
            maxSteps: 10,
            skipFirstObservation: true,
            terminalActions: {
              done: { type: 'success', resultFields: ['result'] },
              fail: { type: 'error', resultFields: ['reason'] },
            },
          },
        }));
      } catch {
        // AgentAbject may not be ready yet — non-fatal
      }
    }
  }

  /**
   * Route a creation task through AgentAbject so each phase appears as a job
   * in JobBrowser. Uses DEFERRED_REPLY on the original `create` message.
   */
  private async runCreationViaAgent(taskId: string): Promise<void> {
    const extra = this.creationTasks.get(taskId)!;
    try {
      const result = await this.request<{ success: boolean; error?: string }>(
        request(this.id, this.agentAbjectId!, 'startTask', {
          taskId,
          task: extra.prompt,
          systemPrompt: this.buildCreationSystemPrompt(),
          config: {
            maxSteps: 10,
            skipFirstObservation: true,
            queueName: `object-creator-${this.id}`,
          },
        }),
        310000,
      );

      // Build a CreationResult from agent task result + stored creation state
      const creationResult: CreationResult = extra.result ?? {
        success: result.success,
        error: result.error,
      };
      await this.sendDeferredReply(extra.deferredMsg, creationResult);
    } catch (err) {
      await this.sendDeferredReply(extra.deferredMsg, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      } as CreationResult).catch(() => {});
    } finally {
      this.creationTasks.delete(taskId);
    }
  }

  private buildCreationSystemPrompt(): string {
    return `You are ObjectCreator, responsible for creating objects from natural language descriptions.

Available actions (output ONE JSON object per turn):
- create_object: Execute the full creation pipeline (discover deps, design manifest, generate code, spawn, connect).
  { "action": "create_object", "reasoning": "Creating the requested object" }
- done: Report success after create_object completes.
  { "action": "done", "result": "Created [object name] successfully" }
- fail: Report failure if create_object failed.
  { "action": "fail", "reason": "..." }

Always begin by executing create_object. After it completes, report done or fail.`;
  }

  protected override getSourceForAsk(): string | undefined {
    return `## ObjectCreator Usage Guide

### Create a New Object

  const result = await call(
    await dep('ObjectCreator'), 'create',
    { prompt: 'a simple counter widget' });
  // result: { success: boolean, objectId?: string, manifest?: AbjectManifest,
  //           code?: string, error?: string, usedObjects?: string[] }

The created object is ALREADY initialized and registered in the system — do NOT call init() on it.
To display it, call show() on the returned objectId:

  if (result.success && result.objectId) {
    await call(result.objectId, 'show', {});
  }

Always create and show in ONE step. Do NOT generate extra steps to "find", "init", or "discover" the created object — the returned objectId and manifest have everything needed.

### Modify an Existing Object

  const result = await call(
    await dep('ObjectCreator'), 'modify',
    { objectId: 'the-object-id', prompt: 'add a reset button' });
  // Returns the same CreationResult shape as create

### Get Suggestions

  const suggestions = await call(
    await dep('ObjectCreator'), 'suggest',
    { context: 'I want to track my daily habits' });
  // Returns string[] of suggested object ideas

### IMPORTANT
- The interface ID is 'abjects:object-creator' (NOT 'abjects:objectcreator').
- create is a long-running operation — call progress() before invoking it if available.
- The returned objectId is ready to use immediately. Do NOT look it up in the registry or call init().
- The returned objectId can be called directly — interface IDs are resolved automatically.`;
  }

  /**
   * Call LLM complete via message passing.
   */
  private async llmComplete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult> {
    return this.request<LLMCompletionResult>(
      request(this.id, this.llmId!, 'complete', { messages, options }),
      310000
    );
  }

  /**
   * List objects from registry via message passing.
   */
  private async registryList(): Promise<ObjectRegistration[]> {
    return this.request<ObjectRegistration[]>(
      request(this.id, this.registryId!, 'list', {})
    );
  }

  /**
   * List objects from the system (global) registry via message passing.
   */
  private async systemRegistryList(): Promise<ObjectRegistration[]> {
    if (!this.systemRegistryId) return [];
    return this.request<ObjectRegistration[]>(
      request(this.id, this.systemRegistryId, 'list', {})
    );
  }

  /**
   * Look up an object in the registry via message passing.
   */
  private async registryLookup(objectId: AbjectId): Promise<ObjectRegistration | null> {
    return this.request<ObjectRegistration | null>(
      request(this.id, this.registryId!, 'lookup', { objectId })
    );
  }

  /**
   * Get object source from registry via message passing.
   */
  private async registryGetSource(objectId: AbjectId): Promise<string | null> {
    return this.request<string | null>(
      request(this.id, this.registryId!, 'getSource', { objectId })
    );
  }

  /**
   * Spawn an object via factory message passing.
   */
  private async factorySpawn(spawnReq: SpawnRequest): Promise<SpawnResult> {
    return this.request<SpawnResult>(
      request(this.id, this.factoryId!, 'spawn', spawnReq)
    );
  }

  /**
   * Update an object's manifest in the registry (re-indexes).
   */
  private async registryUpdateManifest(objectId: AbjectId, manifest: AbjectManifest): Promise<boolean> {
    return this.request<boolean>(
      request(this.id, this.registryId!, 'updateManifest', { objectId, manifest })
    );
  }

  /**
   * Update an object's source in the registry.
   */
  private async registryUpdateSource(objectId: AbjectId, source: string): Promise<boolean> {
    return this.request<boolean>(
      request(this.id, this.registryId!, 'updateSource', { objectId, source })
    );
  }

  private async reportProgress(callerId: AbjectId, phase: string, message: string): Promise<void> {
    try {
      await this.send(
        event(this.id, callerId, 'progress', { phase, message })
      );
    } catch { /* best-effort */ }
  }

  // ── Post-Spawn Probe Validation ──────────────────────────────────

  /**
   * Phase 5b: Probe a live ScriptableAbject to validate that all dependencies
   * referenced in its source (this.dep('...') / this.find('...')) can be resolved.
   */
  private async probeObject(objectId: AbjectId): Promise<{ success: boolean; missingDeps: string[]; error: string }> {
    try {
      const result = await this.request<{ success: boolean; missingDeps: string[]; error: string }>(
        request(this.id, objectId, 'probe', {}),
        15000
      );
      return result;
    } catch (err) {
      return { success: false, missingDeps: [], error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Phase 5c: Retry with probe feedback — re-run dependency selection with error context,
   * regenerate handler code, and apply the fix to the live object.
   */
  private async retryWithProbeFeedback(
    objectId: AbjectId,
    manifest: AbjectManifest,
    prompt: string,
    previousCode: string,
    probeError: string,
    summaries: ObjectSummary[],
    originalDeps: SelectedDependency[],
    usedObjects: string[],
    context: string | undefined,
    callerId: AbjectId | undefined
  ): Promise<{ success: boolean; code?: string; deps?: SelectedDependency[]; error?: string }> {
    // 1. Re-run Phase 0b with augmented prompt including probe error
    if (callerId) await this.reportProgress(callerId, '5c', 'Re-selecting dependencies with probe feedback...');
    const augmentedPrompt =
      `${prompt}\n\nIMPORTANT: A previous attempt failed because these dependencies are missing: ${probeError}. Make sure to select them.`;
    const newSelectedNames = await this.llmSelectDependencies(augmentedPrompt, summaries);
    console.log('[OBJECT-CREATOR probe-retry] Re-selected dependencies:', newSelectedNames);

    // 2. Identify newly discovered deps (diff against originals)
    const originalNames = new Set(originalDeps.map((d) => d.name.toLowerCase()));
    const newNames = newSelectedNames.filter((n) => !originalNames.has(n.toLowerCase()));

    // 3. Fetch manifests, questions, and usage guides for new deps only
    let allDeps = [...originalDeps];
    let depContext: string;

    if (newNames.length > 0) {
      if (callerId) await this.reportProgress(callerId, '5c', `Learning about new deps: ${newNames.join(', ')}...`);
      const newDeps = await this.fetchFullManifests(newNames, summaries);
      const newQuestions = await this.generateTargetedQuestions(prompt, newDeps);
      const newGuides = await this.fetchUsageGuides(newDeps, newQuestions, callerId);

      // Merge new deps with originals
      allDeps = [...originalDeps, ...newDeps];

      // Re-fetch usage guides for all deps (originals already have context, but
      // we need a unified depContext string)
      const allGuides = await this.fetchUsageGuides(originalDeps, undefined, undefined);
      for (const [k, v] of newGuides) allGuides.set(k, v);
      depContext = this.formatFullManifestContext(allDeps, allGuides);
    } else {
      depContext = this.formatFullManifestContext(allDeps);
    }

    // 4. Re-run Phase 2 with updated depContext and error feedback
    if (callerId) await this.reportProgress(callerId, '5c', 'Regenerating handler code...');
    const errorFeedback = `Runtime probe found missing dependencies: ${probeError}. ` +
      `The code references objects that don't exist. Fix the code to use only the available dependencies listed below.`;
    let code = await this.regenerateHandlerCode(
      manifest, prompt, depContext, usedObjects, previousCode, errorFeedback, context
    );
    if (!code) {
      return { success: false, error: 'Failed to regenerate handler code after probe feedback' };
    }

    // 5. Phases 3+4: verify + compile
    if (callerId) await this.reportProgress(callerId, '5c', 'Verifying regenerated code...');
    const verified = this.verifyAndFix(manifest, code);
    code = verified.code;

    if (verified.mismatches.length > 0) {
      try {
        const llmFixed = await this.llmVerifyAndFix(verified.manifest, code, verified.mismatches);
        if (!ScriptableAbject.tryCompile(llmFixed.code)) {
          code = llmFixed.code;
        }
      } catch { /* continue with current code */ }
    }

    const compileError = ScriptableAbject.tryCompile(code);
    if (compileError) {
      return { success: false, error: `Compilation failed after probe retry: ${compileError}` };
    }

    // 6. Clean up partial UI (in case show() left partial windows)
    if (this.widgetManagerId) {
      try {
        await this.request(
          request(this.id, this.widgetManagerId,
            'destroyWindowsForOwner', { ownerId: objectId })
        );
      } catch { /* best effort */ }
    }

    // 7. Apply fix via updateSource to the live object (hide → swap → show)
    if (callerId) await this.reportProgress(callerId, '5c', 'Applying fixed code...');
    try {
      const updateResult = await this.request<{ success: boolean; error?: string }>(
        request(this.id, objectId, 'updateSource', { source: code }),
        30000
      );
      if (!updateResult.success) {
        return { success: false, error: `Failed to apply fixed source: ${updateResult.error}` };
      }
    } catch (err) {
      return { success: false, error: `Failed to apply fixed source: ${err instanceof Error ? err.message : String(err)}` };
    }

    // 8. Update registry source and persist
    await this.registryUpdateSource(objectId, code);
    if (this.abjectStoreId) {
      this.request(
        request(this.id, this.abjectStoreId, 'save', {
          objectId: objectId as string, manifest, source: code, owner: this.id as string,
        })
      ).catch(err => console.warn('[OBJECT-CREATOR probe-retry] Failed to persist:', err));
    }

    return { success: true, code, deps: allDeps };
  }

  // ── Multi-Phase Discovery Pipeline ────────────────────────────────

  /**
   * Phase 0a: Get summaries (name + description) of all registered objects.
   * Queries both the workspace registry and the system registry, deduplicating by ID.
   */
  private async discoverObjectSummaries(): Promise<ObjectSummary[]> {
    const allObjects: ObjectRegistration[] = [];
    if (this.registryId) allObjects.push(...await this.registryList());
    if (this.systemRegistryId) allObjects.push(...await this.systemRegistryList());
    // Deduplicate by ID
    const seen = new Set<string>();
    return allObjects.filter(o => {
      if (seen.has(o.id)) return false;
      seen.add(o.id);
      return true;
    }).map(o => ({
      id: o.id,
      name: o.manifest.name,
      description: o.manifest.description,
    }));
  }

  /**
   * Phase 0b: Ask LLM to select which objects the new object needs as dependencies.
   */
  private async llmSelectDependencies(
    prompt: string,
    summaries: ObjectSummary[]
  ): Promise<string[]> {
    if (summaries.length === 0 || !this.llmId) return [];

    const summaryText = summaries
      .map((s) => `- ${s.name}: ${s.description}`)
      .join('\n');

    const result = await this.llmComplete([
      systemMessage(
        'Given a list of object names and descriptions, return ONLY the names the new object needs as dependencies. ' +
        'Study each object\'s description — including any listed use cases — to determine if the new object needs its methods or will receive its events. ' +
        'IMPORTANT: Objects run in a sandboxed environment with NO access to browser globals (fetch, setTimeout, localStorage, etc). ' +
        'If the new object needs HTTP requests, timers, storage, or other capabilities, it MUST depend on the object that provides them. ' +
        'CRITICAL: If the task mentions a specific website or platform by name (e.g. "Instagram app", "Twitter client", "YouTube viewer", "Reddit browser"), ' +
        'this means "build an app that USES the web automation object to interact with that actual website" — NOT a local clone or imitation of it. ' +
        'Social media sites, email, and web apps require JavaScript rendering and login — always choose the web automation object (WebBrowser), not just HttpClient. ' +
        'Only choose HttpClient WITHOUT WebBrowser for tasks that explicitly mention REST APIs, JSON endpoints, or RSS feeds. ' +
        'Do NOT create objects that merely display links or mock data — the user expects actual interaction with the real website. ' +
        'Return one name per line, nothing else. If no dependencies are needed, return "None".'
      ),
      userMessage(`Available objects:\n${summaryText}\n\nNew object to create: ${prompt}\n\nWhich objects does it need?`),
    ], { tier: 'smart' });

    const content = result.content.trim();
    if (content.toLowerCase() === 'none') return [];

    return content
      .split('\n')
      .map((n) => n.trim().replace(/^-\s*/, ''))
      .filter((n) => n.length > 0 && n.toLowerCase() !== 'none');
  }

  /**
   * Ask an object to describe itself via the introspect protocol.
   */
  private async introspect(objectId: AbjectId): Promise<IntrospectResult | null> {
    try {
      return await this.request<IntrospectResult>(
        request(this.id, objectId, 'describe', {})
      );
    } catch {
      return null;
    }
  }

  /**
   * Phase 0c: Ask selected objects to describe themselves via introspect protocol.
   */
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

      const result = await this.introspect(summary.id);
      if (result) {
        deps.push({
          id: summary.id,
          name: result.manifest.name,
          manifest: result.manifest,
          description: result.description,
        });
      }
    }

    return deps;
  }

  /**
   * Ask a dependency about its usage via the introspect 'ask' protocol.
   * Returns null on failure (LLM not available, timeout, etc.).
   */
  private async askDependency(objectId: AbjectId, question: string): Promise<string | null> {
    try {
      return await this.request<string>(
        request(this.id, objectId, 'ask', { question }),
        60000
      );
    } catch {
      return null;
    }
  }

  /**
   * Phase 0c5: Generate targeted questions for each dependency based on the user's prompt.
   * Returns a Map of dep name → targeted question. On failure, returns an empty Map
   * so Phase 0d falls back to generic questions.
   */
  private async generateTargetedQuestions(
    prompt: string,
    deps: SelectedDependency[]
  ): Promise<Map<string, string>> {
    if (deps.length === 0 || !this.llmId) return new Map();

    try {
      const depList = deps
        .map((d) => `- ${d.name}: ${d.description.slice(0, 300)}`)
        .join('\n');

      const result = await this.llmComplete([
        systemMessage(
          'You are helping build a new object in a distributed system. ' +
          'Given the user\'s goal and a list of dependency objects, generate ONE targeted question per dependency. ' +
          'Each question should ask the dependency specifically how to accomplish what the user needs, referencing concrete methods or events.\n\n' +
          'Format: one line per dependency, exactly like this:\n' +
          '[DepName]: Your targeted question here?\n\n' +
          'Output ONLY the questions, one per line. Nothing else.'
        ),
        userMessage(
          `User wants to create: ${prompt}\n\nDependencies:\n${depList}\n\n` +
          `Generate a targeted question for each dependency.`
        ),
      ], { tier: 'balanced' });

      return this.parseTargetedQuestions(result.content, deps.map((d) => d.name));
    } catch (err) {
      console.warn('[OBJECT-CREATOR] Failed to generate targeted questions, falling back to generic:', err);
      return new Map();
    }
  }

  /**
   * Parse LLM response for targeted questions. Matches lines like "[Name]: question" or "Name: question".
   * Uses case-insensitive fuzzy matching against known dep names.
   */
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

  /**
   * Ask each dependency in parallel for a usage guide via the 'ask' protocol.
   * If customQuestions is provided, uses targeted questions per dep; otherwise falls back to generic.
   * Reports per-dependency progress when callerId is provided.
   */
  private async fetchUsageGuides(
    deps: SelectedDependency[],
    customQuestions?: Map<string, string>,
    callerId?: AbjectId
  ): Promise<Map<string, string>> {
    const guides = new Map<string, string>();
    if (deps.length === 0) return guides;

    const genericQuestion =
      'How should another object use your methods? Give a concise guide with example this.call() invocations, event handler patterns, and any important constraints.';

    const promises = deps.map(async (dep) => {
      const question = customQuestions?.get(dep.name) ?? genericQuestion;
      if (callerId) await this.reportProgress(callerId, '0d', `Asking ${dep.name}: ${question}`);
      const guide = await this.askDependency(dep.id, question);
      if (guide) {
        guides.set(dep.name, guide);
      }
    });

    await Promise.all(promises);
    return guides;
  }

  /**
   * Format full manifest context for LLM prompts using introspect descriptions
   * and LLM-powered usage guides from the 'ask' protocol.
   */
  private formatFullManifestContext(deps: SelectedDependency[], usageGuides?: Map<string, string>): string {
    if (deps.length === 0) return 'None';

    return deps
      .map((dep) => {
        let text = `## ${dep.name} (id available as this.dep('${dep.name}'))\n${dep.description}\n\n  Usage: this.call(this.dep('${dep.name}'), methodName, payload)`;
        const guide = usageGuides?.get(dep.name);
        if (guide) {
          text += `\n\n### Usage Guide (from ${dep.name} itself):\n${guide}`;
        }
        return text;
      })
      .join('\n\n---\n\n');
  }

  // ── Object Creation ───────────────────────────────────────────────

  /**
   * Create a new object from a natural language prompt.
   * Uses multi-phase pipeline: discovery → manifest → code → verify → spawn.
   */
  async createObject(prompt: string, context?: string, callerId?: AbjectId): Promise<CreationResult> {
    require(this.llmId !== undefined, 'LLM not set');
    require(this.registryId !== undefined, 'Registry not set');

    try {
      this._currentCallerId = callerId;

      // Phase 0a: Get object summaries
      if (callerId) await this.reportProgress(callerId, '0a', 'Discovering available objects...');
      const summaries = await this.discoverObjectSummaries();

      // Phase 0b: LLM selects dependencies
      if (callerId) await this.reportProgress(callerId, '0b', 'Choosing dependencies...');
      const selectedNames = await this.llmSelectDependencies(prompt, summaries);
      console.log('[OBJECT-CREATOR] Selected dependencies:', selectedNames);

      // Phase 0c: Fetch full manifests for selected dependencies
      const depNames = selectedNames.join(', ') || 'none';
      if (callerId) await this.reportProgress(callerId, '0c', `Learning about ${depNames}...`);
      let deps = await this.fetchFullManifests(selectedNames, summaries);
      console.log('[OBJECT-CREATOR] Fetched manifests for:', deps.map((d) => d.name));

      // Phase 0c5: Generate targeted questions for each dependency
      if (callerId) await this.reportProgress(callerId, '0c5', 'Formulating questions...');
      const targetedQuestions = await this.generateTargetedQuestions(prompt, deps);
      console.log('[OBJECT-CREATOR] Generated targeted questions for:', Array.from(targetedQuestions.keys()));

      // Phase 0d: Ask each dependency for usage guides (with targeted questions)
      const usageGuides = await this.fetchUsageGuides(deps, targetedQuestions, callerId);
      console.log('[OBJECT-CREATOR] Got usage guides from:', Array.from(usageGuides.keys()));

      const depContext = this.formatFullManifestContext(deps, usageGuides);

      // Phase 1: Generate manifest
      if (callerId) await this.reportProgress(callerId, '1', 'Designing object manifest...');
      const phase1 = await this.generateManifest(prompt, depContext, context);
      if (!phase1.manifest) {
        this._currentCallerId = undefined;
        return { success: false, error: 'Phase 1: Failed to generate valid manifest' };
      }

      // Phases 2–4: Generate handler code, verify, compile — with retry loop
      const MAX_CODE_ATTEMPTS = 3;
      let code: string | undefined;
      let manifest = phase1.manifest;
      let lastError = '';

      for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
        // Phase 2: Generate handler code (with feedback on retry)
        if (attempt === 1) {
          if (callerId) await this.reportProgress(callerId, '2', 'Generating handler code...');
          code = await this.generateHandlerCode(
            manifest, prompt, depContext, phase1.usedObjects, context
          );
        } else {
          if (callerId) await this.reportProgress(callerId, '2', `Generating handler code (retry ${attempt}/${MAX_CODE_ATTEMPTS})...`);
          console.log(`[OBJECT-CREATOR] Retry ${attempt}/${MAX_CODE_ATTEMPTS}: ${lastError}`);
          code = await this.regenerateHandlerCode(
            manifest, prompt, depContext, phase1.usedObjects, code ?? '', lastError, context
          );
        }
        if (!code) {
          lastError = 'Failed to generate handler code (LLM did not return a javascript code block)';
          console.warn(`[OBJECT-CREATOR] Attempt ${attempt}: ${lastError}`);
          continue;
        }

        // Phase 3: Verify manifest/code consistency
        if (callerId) await this.reportProgress(callerId, '3', 'Verifying code...');
        const verified = this.verifyAndFix(manifest, code);
        manifest = verified.manifest;
        code = verified.code;

        // Phase 3b: LLM-assisted fix if needed
        if (verified.mismatches.length > 0) {
          try {
            const llmFixed = await this.llmVerifyAndFix(manifest, code, verified.mismatches);
            // Only accept if the fix still compiles — truncated LLM responses break code
            if (!ScriptableAbject.tryCompile(llmFixed.code)) {
              manifest = llmFixed.manifest;
              code = llmFixed.code;
            } else {
              console.warn('[OBJECT-CREATOR] Phase 3b produced non-compiling code, keeping original');
            }
          } catch (err) {
            console.warn('[OBJECT-CREATOR] LLM verify/fix failed, continuing:', err);
          }
        }

        // Phase 3c: Re-verify after fixes
        const recheck = this.verifyAndFix(manifest, code);
        manifest = recheck.manifest;
        code = recheck.code;
        const missingHandlers = recheck.mismatches.filter((m) => m.startsWith('Missing handler:'));
        if (missingHandlers.length > 0) {
          lastError = `Handler code is missing required methods: ${missingHandlers.join('; ')}`;
          console.warn(`[OBJECT-CREATOR] Attempt ${attempt}: ${lastError}`);
          if (attempt < MAX_CODE_ATTEMPTS) continue;
          return { success: false, error: lastError, code };
        }

        // Phase 4: Compile check
        if (callerId) await this.reportProgress(callerId, '4', 'Compiling...');
        const compileError = ScriptableAbject.tryCompile(code);
        if (compileError) {
          // Try a single LLM compile fix
          const fixResult = await this.llmComplete([
            systemMessage(
              'The following JavaScript handler map failed to compile with `new Function()`. ' +
              'Fix it so it is valid plain JavaScript. No TypeScript annotations, no type casts, no interfaces. ' +
              'You MUST keep ALL handler methods — do not remove any. ' +
              'Output ONLY the corrected handler map in a ```javascript code block. Nothing else.'
            ),
            userMessage(`Handler map:\n\`\`\`javascript\n${code}\n\`\`\`\n\nError: ${compileError}`),
          ], { tier: 'balanced' });
          const fixMatch = fixResult.content.match(/```(?:javascript|js)\s*([\s\S]*?)\s*```/);
          if (fixMatch && !ScriptableAbject.tryCompile(fixMatch[1])) {
            code = fixMatch[1];
          } else {
            lastError = `Compilation failed: ${compileError}`;
            console.warn(`[OBJECT-CREATOR] Attempt ${attempt}: ${lastError}`);
            if (attempt < MAX_CODE_ATTEMPTS) continue;
            return { success: false, error: lastError, code };
          }

          // Re-verify after compile fix — the LLM may have dropped methods
          const postCompileCheck = this.verifyAndFix(manifest, code);
          const postMissing = postCompileCheck.mismatches.filter((m) => m.startsWith('Missing handler:'));
          if (postMissing.length > 0) {
            lastError = `Compile fix dropped required methods: ${postMissing.join('; ')}`;
            console.warn(`[OBJECT-CREATOR] Attempt ${attempt}: ${lastError}`);
            if (attempt < MAX_CODE_ATTEMPTS) continue;
            return { success: false, error: lastError, code };
          }
        }

        // All checks passed
        lastError = '';
        break;
      }

      if (lastError) {
        return { success: false, error: lastError, code };
      }

      // Phase 5: Spawn via Factory
      if (callerId) await this.reportProgress(callerId, '5', 'Spawning object...');
      if (this.factoryId) {
        const spawnResult = await this.factorySpawn({
          manifest,
          source: code,
          owner: this.id,
          parentId: this.id,
          registryHint: this.registryId,
        });

        // Phase 5b: Probe validation — check that all deps referenced in source resolve
        if (spawnResult.objectId) {
          if (callerId) await this.reportProgress(callerId, '5b', 'Validating dependencies...');
          let probeResult = await this.probeObject(spawnResult.objectId);
          console.log('[OBJECT-CREATOR] Probe result:', probeResult);

          if (!probeResult.success) {
            const MAX_RUNTIME_ATTEMPTS = 2;
            for (let attempt = 1; attempt <= MAX_RUNTIME_ATTEMPTS; attempt++) {
              if (callerId) await this.reportProgress(callerId, '5c', `Runtime error recovery attempt ${attempt}/${MAX_RUNTIME_ATTEMPTS}...`);
              console.log(`[OBJECT-CREATOR] Probe retry ${attempt}/${MAX_RUNTIME_ATTEMPTS}: ${probeResult.error}`);

              const retryResult = await this.retryWithProbeFeedback(
                spawnResult.objectId, manifest, prompt, code!, probeResult.error,
                summaries, deps, phase1.usedObjects, context, callerId
              );

              if (!retryResult.success) {
                if (attempt === MAX_RUNTIME_ATTEMPTS) {
                  this._currentCallerId = undefined;
                  return { success: false, objectId: spawnResult.objectId, manifest, code, error: retryResult.error };
                }
                continue;
              }

              // Update code and deps for Phase 6 connect
              code = retryResult.code ?? code;
              if (retryResult.deps) deps = retryResult.deps;

              // Re-probe to verify the fix worked
              probeResult = await this.probeObject(spawnResult.objectId);
              console.log('[OBJECT-CREATOR] Post-retry probe result:', probeResult);
              if (probeResult.success) break;
            }

            if (!probeResult.success) {
              this._currentCallerId = undefined;
              return { success: false, objectId: spawnResult.objectId, manifest, code, error: probeResult.error };
            }
          }
        }

        // Phase 6: Connect to dependencies via Negotiator (fire-and-forget)
        if (callerId && deps.length > 0) {
          const connectNames = deps.map((d) => d.name).join(', ');
          await this.reportProgress(callerId, '6', `Connecting to ${connectNames}...`);
        }
        // TODO: Re-enable Negotiator connect when implementation is improved
        // if (this.negotiatorId && spawnResult.objectId) {
        //   for (const dep of deps) {
        //     this.request(request(
        //       this.id, this.negotiatorId,
        //       'connect',
        //       { sourceId: spawnResult.objectId, targetId: dep.id }
        //     )).catch((err) => {
        //       console.warn(`[OBJECT-CREATOR] Connect to ${dep.name} failed:`, err);
        //     });
        //   }
        // }

        // Tag the new object with ObjectCreator's own workspace so its windows
        // are scoped to the workspace where it was created
        if (this.widgetManagerId && spawnResult.objectId) {
          try {
            const wsId = await this.request<string | null>(
              request(this.id, this.widgetManagerId,
                'getObjectWorkspace', { objectId: this.id })
            );
            if (wsId) {
              await this.request(
                request(this.id, this.widgetManagerId,
                  'setObjectWorkspace', {
                    objectId: spawnResult.objectId,
                    workspaceId: wsId,
                  })
              );
            }
          } catch { /* best effort */ }
        }

        // Persist to AbjectStore (fire-and-forget)
        if (this.abjectStoreId && spawnResult.objectId && code) {
          this.request(
            request(this.id, this.abjectStoreId, 'save', {
              objectId: spawnResult.objectId, manifest, source: code, owner: this.id as string,
            })
          ).catch(err => console.warn('[OBJECT-CREATOR] Failed to persist:', err));
        }

        this._currentCallerId = undefined;
        return {
          success: true,
          objectId: spawnResult.objectId,
          manifest,
          code,
          usedObjects: phase1.usedObjects,
        };
      }

      this._currentCallerId = undefined;
      return {
        success: true,
        manifest,
        code,
        usedObjects: phase1.usedObjects,
      };
    } catch (err) {
      this._currentCallerId = undefined;
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Phase M: Generate only the updated manifest JSON for a modification.
   */
  private async generateModifiedManifest(
    prompt: string,
    currentManifest: AbjectManifest,
    currentSource: string | null,
    depContext: string
  ): Promise<{ manifest?: AbjectManifest; usedObjects: string[] }> {
    const sourceBlock = currentSource
      ? `\nCurrent handler source:\n\`\`\`javascript\n${currentSource}\n\`\`\`\n`
      : '';

    const messages: LLMMessage[] = [
      systemMessage(this.getModificationManifestPrompt()),
      userMessage(
        `Available dependencies:\n${depContext}\n\n` +
        `Current manifest:\n\`\`\`json\n${JSON.stringify(currentManifest, null, 2)}\n\`\`\`\n` +
        `${sourceBlock}\n` +
        `Modification request: ${prompt}\n\n` +
        `Design the updated manifest for this modification.`
      ),
    ];

    const result = await this.llmComplete(messages, { tier: 'smart' });
    return this.parseManifestResponse(result.content);
  }

  /**
   * Phase 2 (modification): Generate handler code for a modified object.
   * Reuses getPhase2SystemPrompt() but includes existing code as context.
   */
  private async generateModifiedHandlerCode(
    manifest: AbjectManifest,
    prompt: string,
    depContext: string,
    usedObjects: string[],
    currentSource: string | null
  ): Promise<string | undefined> {
    const methodList = manifest.interface.methods.map((m) => m.name);

    const existingCodeBlock = currentSource
      ? `\n\nExisting handler code to modify (preserve working logic, add/change only what the modification requires):\n\`\`\`javascript\n${currentSource}\n\`\`\`\n`
      : '';

    const messages: LLMMessage[] = [
      systemMessage(this.getPhase2SystemPrompt()),
      userMessage(
        `Manifest:\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\n` +
        `You MUST implement handlers for these methods: ${methodList.join(', ')}\n\n` +
        `Available dependencies:\n${depContext}\n\n` +
        `Used objects: ${usedObjects.length > 0 ? usedObjects.join(', ') : 'None'}\n\n` +
        `Modification request: ${prompt}` +
        `${existingCodeBlock}\n\n` +
        `Generate the complete updated handler map incorporating the requested changes.`
      ),
    ];

    const result = await this.llmComplete(messages, { tier: 'balanced', maxTokens: 16384 });
    console.log(`[OBJECT-CREATOR] Modify Phase 2 LLM response (${result.content.length} chars):\n${result.content.slice(0, 500)}`);
    return this.parseCodeResponse(result.content);
  }

  /**
   * Modify an existing object using the full multi-phase pipeline.
   */
  async modifyObject(objectId: AbjectId, prompt: string, callerId?: AbjectId): Promise<CreationResult> {
    require(this.llmId !== undefined, 'LLM not set');
    require(this.registryId !== undefined, 'Registry not set');

    const registration = await this.registryLookup(objectId);
    if (!registration) {
      return { success: false, error: 'Object not found' };
    }

    const currentSource = await this.registryGetSource(objectId);

    try {
      this._currentCallerId = callerId;

      // Phase 0a: Get object summaries
      if (callerId) await this.reportProgress(callerId, '0a', 'Discovering available objects...');
      const summaries = await this.discoverObjectSummaries();

      // Phase 0b: LLM selects dependencies
      if (callerId) await this.reportProgress(callerId, '0b', 'Choosing dependencies...');
      const selectedNames = await this.llmSelectDependencies(prompt, summaries);
      console.log('[OBJECT-CREATOR modify] Selected dependencies:', selectedNames);

      // Phase 0c: Fetch full manifests for selected dependencies
      const depNames = selectedNames.join(', ') || 'none';
      if (callerId) await this.reportProgress(callerId, '0c', `Learning about ${depNames}...`);
      const deps = await this.fetchFullManifests(selectedNames, summaries);
      console.log('[OBJECT-CREATOR modify] Fetched manifests for:', deps.map((d) => d.name));

      // Phase 0c5: Generate targeted questions for each dependency
      if (callerId) await this.reportProgress(callerId, '0c5', 'Formulating questions...');
      const targetedQuestions = await this.generateTargetedQuestions(prompt, deps);
      console.log('[OBJECT-CREATOR modify] Generated targeted questions for:', Array.from(targetedQuestions.keys()));

      // Phase 0d: Ask each dependency for usage guides (with targeted questions)
      const usageGuides = await this.fetchUsageGuides(deps, targetedQuestions, callerId);
      console.log('[OBJECT-CREATOR modify] Got usage guides from:', Array.from(usageGuides.keys()));

      const depContext = this.formatFullManifestContext(deps, usageGuides);

      // Phase M: Generate updated manifest
      if (callerId) await this.reportProgress(callerId, 'M', 'Updating manifest...');
      const phaseM = await this.generateModifiedManifest(prompt, registration.manifest, currentSource, depContext);
      if (!phaseM.manifest) {
        return { success: false, error: 'Phase M: Failed to generate valid updated manifest' };
      }

      // Phases 2-4: Generate handler code, verify, compile — with retry loop
      const MAX_CODE_ATTEMPTS = 3;
      let code: string | undefined;
      let manifest = phaseM.manifest;
      let lastError = '';

      for (let attempt = 1; attempt <= MAX_CODE_ATTEMPTS; attempt++) {
        // Phase 2: Generate handler code (with feedback on retry)
        if (attempt === 1) {
          if (callerId) await this.reportProgress(callerId, '2', 'Generating updated handler code...');
          code = await this.generateModifiedHandlerCode(
            manifest, prompt, depContext, phaseM.usedObjects, currentSource
          );
        } else {
          if (callerId) await this.reportProgress(callerId, '2', `Generating handler code (retry ${attempt}/${MAX_CODE_ATTEMPTS})...`);
          console.log(`[OBJECT-CREATOR modify] Retry ${attempt}/${MAX_CODE_ATTEMPTS}: ${lastError}`);
          code = await this.regenerateHandlerCode(
            manifest, prompt, depContext, phaseM.usedObjects, code ?? '', lastError
          );
        }
        if (!code) {
          lastError = 'Failed to generate handler code (LLM did not return a javascript code block)';
          console.warn(`[OBJECT-CREATOR modify] Attempt ${attempt}: ${lastError}`);
          continue;
        }

        // Phase 3: Verify manifest/code consistency
        if (callerId) await this.reportProgress(callerId, '3', 'Verifying code...');
        const verified = this.verifyAndFix(manifest, code);
        manifest = verified.manifest;
        code = verified.code;

        // Phase 3b: LLM-assisted fix if needed
        if (verified.mismatches.length > 0) {
          try {
            const llmFixed = await this.llmVerifyAndFix(manifest, code, verified.mismatches);
            // Only accept if the fix still compiles — truncated LLM responses break code
            if (!ScriptableAbject.tryCompile(llmFixed.code)) {
              manifest = llmFixed.manifest;
              code = llmFixed.code;
            } else {
              console.warn('[OBJECT-CREATOR modify] Phase 3b produced non-compiling code, keeping original');
            }
          } catch (err) {
            console.warn('[OBJECT-CREATOR modify] LLM verify/fix failed, continuing:', err);
          }
        }

        // Phase 3c: Re-verify after fixes
        const recheck = this.verifyAndFix(manifest, code);
        manifest = recheck.manifest;
        code = recheck.code;
        const missingHandlers = recheck.mismatches.filter((m) => m.startsWith('Missing handler:'));
        if (missingHandlers.length > 0) {
          lastError = `Handler code is missing required methods: ${missingHandlers.join('; ')}`;
          console.warn(`[OBJECT-CREATOR modify] Attempt ${attempt}: ${lastError}`);
          if (attempt < MAX_CODE_ATTEMPTS) continue;
          return { success: false, error: lastError, code };
        }

        // Phase 4: Compile check
        if (callerId) await this.reportProgress(callerId, '4', 'Compiling...');
        const compileError = ScriptableAbject.tryCompile(code);
        if (compileError) {
          // Try a single LLM compile fix
          const fixResult = await this.llmComplete([
            systemMessage(
              'The following JavaScript handler map failed to compile with `new Function()`. ' +
              'Fix it so it is valid plain JavaScript. No TypeScript annotations, no type casts, no interfaces. ' +
              'You MUST keep ALL handler methods — do not remove any. ' +
              'Output ONLY the corrected handler map in a ```javascript code block. Nothing else.'
            ),
            userMessage(`Handler map:\n\`\`\`javascript\n${code}\n\`\`\`\n\nError: ${compileError}`),
          ], { tier: 'balanced' });
          const fixMatch = fixResult.content.match(/```(?:javascript|js)\s*([\s\S]*?)\s*```/);
          if (fixMatch && !ScriptableAbject.tryCompile(fixMatch[1])) {
            code = fixMatch[1];
          } else {
            lastError = `Compilation failed: ${compileError}`;
            console.warn(`[OBJECT-CREATOR modify] Attempt ${attempt}: ${lastError}`);
            if (attempt < MAX_CODE_ATTEMPTS) continue;
            return { success: false, error: lastError, code };
          }

          // Re-verify after compile fix
          const postCompileCheck = this.verifyAndFix(manifest, code);
          const postMissing = postCompileCheck.mismatches.filter((m) => m.startsWith('Missing handler:'));
          if (postMissing.length > 0) {
            lastError = `Compile fix dropped required methods: ${postMissing.join('; ')}`;
            console.warn(`[OBJECT-CREATOR modify] Attempt ${attempt}: ${lastError}`);
            if (attempt < MAX_CODE_ATTEMPTS) continue;
            return { success: false, error: lastError, code };
          }
        }

        // All checks passed
        lastError = '';
        break;
      }

      if (lastError) {
        return { success: false, error: lastError, code };
      }

      // Phase 5: Apply changes to live object and registry
      if (callerId) await this.reportProgress(callerId, '5', 'Applying changes...');

      // 5a: Update source on the live ScriptableAbject (hot-reload: hide → swap → show)
      try {
        const updateResult = await this.request<{ success: boolean; error?: string }>(
          request(this.id, objectId, 'updateSource', { source: code }),
          30000  // generous timeout — hide + applySource + show may take time
        );
        if (!updateResult.success) {
          return { success: false, error: `Failed to apply source to live object: ${updateResult.error}`, code };
        }
      } catch (err) {
        console.warn('[OBJECT-CREATOR modify] Failed to update live object source:', err);
        return { success: false, error: `Failed to apply source to live object: ${err instanceof Error ? err.message : String(err)}`, code };
      }

      // 5b: Update source in Registry
      await this.registryUpdateSource(objectId, code!);

      // 5c: Update manifest in Registry
      await this.registryUpdateManifest(objectId, manifest);

      // 5c2: Persist to AbjectStore (fire-and-forget)
      if (this.abjectStoreId && code) {
        this.request(
          request(this.id, this.abjectStoreId, 'save', {
            objectId: objectId as string, manifest, source: code, owner: this.id as string,
          })
        ).catch(err => console.warn('[OBJECT-CREATOR modify] Failed to persist:', err));
      }

      // Phase 6: Connect to any new dependencies via Negotiator
      if (callerId && deps.length > 0) {
        const connectNames = deps.map((d) => d.name).join(', ');
        await this.reportProgress(callerId, '6', `Connecting to ${connectNames}...`);
      }
      // TODO: Re-enable Negotiator connect when implementation is improved
      // if (this.negotiatorId) {
      //   for (const dep of deps) {
      //     this.request(request(
      //       this.id, this.negotiatorId,
      //       'connect',
      //       { sourceId: objectId, targetId: dep.id }
      //     )).catch((err) => {
      //       console.warn(`[OBJECT-CREATOR modify] Connect to ${dep.name} failed:`, err);
      //     });
      //   }
      // }

      this._currentCallerId = undefined;
      return {
        success: true,
        objectId,
        manifest,
        code,
        usedObjects: phaseM.usedObjects,
      };
    } catch (err) {
      this._currentCallerId = undefined;
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Get suggestions for objects to create.
   */
  async suggestObjects(context: string): Promise<string[]> {
    require(this.llmId !== undefined, 'LLM not set');

    const available = await this.listAvailableObjects();
    const availableList = available.map((o) => `- ${o.manifest.name}: ${o.manifest.description}`).join('\n');

    const result = await this.llmComplete([
      systemMessage(
        'You suggest objects that would be useful to create in an Abjects system. Keep suggestions practical and composable with existing objects.'
      ),
      userMessage(`Available objects:
${availableList}

User's goal: ${context}

Suggest 3-5 objects that would help achieve this goal. Format: one suggestion per line.`),
    ], { tier: 'fast' });

    return result.content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /**
   * List available objects for composition.
   */
  async listAvailableObjects(): Promise<ObjectRegistration[]> {
    if (!this.registryId) {
      return [];
    }
    return this.registryList();
  }

  /**
   * Get the object dependency graph.
   */
  async getObjectGraph(): Promise<{
    nodes: Array<{ id: string; name: string }>;
    edges: Array<{ from: string; to: string }>;
  }> {
    if (!this.registryId) {
      return { nodes: [], edges: [] };
    }

    const objects = await this.registryList();
    const nodes = objects.map((o) => ({
      id: o.id,
      name: o.manifest.name,
    }));

    // TODO: Track actual connections between objects
    const edges: Array<{ from: string; to: string }> = [];

    return { nodes, edges };
  }

  // ── Manifest & Code Generation ────────────────────────────────────

  /**
   * Phase 1: Generate only the manifest JSON from user prompt.
   */
  private async generateManifest(
    prompt: string,
    depContext: string,
    context?: string
  ): Promise<{ manifest?: AbjectManifest; usedObjects: string[] }> {
    const messages: LLMMessage[] = [
      systemMessage(this.getPhase1SystemPrompt()),
      userMessage(`Available dependencies:\n${depContext}\n\n${context ? `Additional context: ${context}\n\n` : ''}User request: ${prompt}\n\nDesign the manifest for this object.`),
    ];

    const result = await this.llmComplete(messages, { tier: 'smart' });
    return this.parseManifestResponse(result.content);
  }

  /**
   * Phase 2: Generate handler code given a manifest as spec.
   */
  private async generateHandlerCode(
    manifest: AbjectManifest,
    prompt: string,
    depContext: string,
    usedObjects: string[],
    context?: string
  ): Promise<string | undefined> {
    const methodList = manifest.interface.methods.map((m) => m.name);

    const messages: LLMMessage[] = [
      systemMessage(this.getPhase2SystemPrompt()),
      userMessage(`Manifest:\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\nYou MUST implement handlers for these methods: ${methodList.join(', ')}\n\nAvailable dependencies:\n${depContext}\n\nUsed objects: ${usedObjects.length > 0 ? usedObjects.join(', ') : 'None'}\n\n${context ? `Additional context: ${context}\n\n` : ''}Original user request: ${prompt}\n\nGenerate the handler map.`),
    ];

    const result = await this.llmComplete(messages, { tier: 'balanced', maxTokens: 16384 });
    console.log(`[OBJECT-CREATOR] Phase 2 LLM response (${result.content.length} chars):\n${result.content.slice(0, 500)}`);
    return this.parseCodeResponse(result.content);
  }

  /**
   * Phase 2 retry: Regenerate handler code with feedback about what went wrong.
   */
  private async regenerateHandlerCode(
    manifest: AbjectManifest,
    prompt: string,
    depContext: string,
    usedObjects: string[],
    previousCode: string,
    errorFeedback: string,
    context?: string
  ): Promise<string | undefined> {
    const methodList = manifest.interface.methods.map((m) => m.name);

    const messages: LLMMessage[] = [
      systemMessage(this.getPhase2SystemPrompt()),
      userMessage(`Manifest:\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\nYou MUST implement handlers for these methods: ${methodList.join(', ')}\n\nAvailable dependencies:\n${depContext}\n\nUsed objects: ${usedObjects.length > 0 ? usedObjects.join(', ') : 'None'}\n\n${context ? `Additional context: ${context}\n\n` : ''}Original user request: ${prompt}\n\nGenerate the handler map.`),
      systemMessage(`Your previous attempt failed with this error:\n${errorFeedback}\n\n${previousCode ? `Previous code:\n\`\`\`javascript\n${previousCode}\n\`\`\`\n\n` : ''}Fix these issues. Remember:\n- The handler map MUST be a FLAT parenthesized object: ({ method(msg) { ... } })\n- You MUST implement ALL methods listed above: ${methodList.join(', ')}\n- Each handler takes a single msg argument\n- MUST be plain JavaScript, NOT TypeScript\n- Do NOT nest handlers under interface keys\n\nGenerate the corrected handler map.`),
    ];

    const result = await this.llmComplete(messages, { tier: 'balanced', maxTokens: 16384 });
    console.log(`[OBJECT-CREATOR] Phase 2 retry LLM response (${result.content.length} chars):\n${result.content.slice(0, 500)}`);
    return this.parseCodeResponse(result.content);
  }

  /**
   * Phase 3: Programmatic verification of manifest/code consistency.
   */
  private verifyAndFix(
    manifest: AbjectManifest,
    code: string
  ): { manifest: AbjectManifest; code: string; mismatches: string[] } {
    const mismatches: string[] = [];

    const declaredMethods = new Set(
      manifest.interface.methods.map((m) => m.name)
    );

    let handlerMap: Record<string, unknown>;
    try {
      handlerMap = new Function('return ' + code)();
      if (typeof handlerMap !== 'object' || handlerMap === null) {
        return { manifest, code, mismatches: [] };
      }
    } catch {
      return { manifest, code, mismatches: [] };
    }

    // Detect nested interface-keyed structure: { "interface:id": { methods... } }
    // All top-level values should be functions or underscore-prefixed state props.
    for (const [key, value] of Object.entries(handlerMap)) {
      if (!key.startsWith('_') && typeof value === 'object' && value !== null) {
        mismatches.push(
          `STRUCTURAL ERROR: Handler map has nested object at key '${key}'. ` +
          `The handler map must be FLAT — all methods directly on the top-level object. ` +
          `Do NOT group methods under interface keys.`
        );
      }
    }

    const handlerNames = Object.keys(handlerMap).filter(
      (k) => !k.startsWith('_') && typeof handlerMap[k] === 'function'
    );
    const implementedMethods = new Set(handlerNames);

    for (const method of declaredMethods) {
      if (!implementedMethods.has(method)) {
        mismatches.push(`Missing handler: '${method}' declared in manifest but not implemented`);
      }
    }

    for (const handler of implementedMethods) {
      if (!declaredMethods.has(handler)) {
        mismatches.push(`Extra handler: '${handler}' implemented but not declared in manifest`);
      }
    }

    // Auto-fix: rename non-manifest helper functions that are called as this.name()
    // These should have a '_' prefix to be callable as direct methods
    const extraHandlers = handlerNames.filter((h) => !declaredMethods.has(h));
    for (const name of extraHandlers) {
      const callPattern = new RegExp(`this\\.${name}\\s*\\(`, 'g');
      if (callPattern.test(code)) {
        const newName = '_' + name;
        // Rename function definition (method shorthand in object literal)
        code = code.replace(
          new RegExp(`(^|[,{\\s])\\b(async\\s+)?${name}\\s*\\(`, 'gm'),
          (match, prefix, asyncKw) => `${prefix}${asyncKw || ''}${newName}(`
        );
        // Rename all this.name( call sites
        code = code.replace(
          new RegExp(`this\\.${name}\\s*\\(`, 'g'),
          `this.${newName}(`
        );
        // Remove from mismatches since we fixed it
        const extraIdx = mismatches.findIndex(
          (m) => m.includes(`'${name}'`) && m.startsWith('Extra handler')
        );
        if (extraIdx >= 0) mismatches.splice(extraIdx, 1);
      }
    }

    return { manifest, code, mismatches };
  }

  /**
   * Phase 3b: LLM fallback to fix manifest/code mismatches.
   */
  private async llmVerifyAndFix(
    manifest: AbjectManifest,
    code: string,
    mismatches: string[]
  ): Promise<{ manifest: AbjectManifest; code: string }> {
    const messages: LLMMessage[] = [
      systemMessage(this.getPhase3SystemPrompt()),
      userMessage(`Manifest:\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\nHandler code:\n\`\`\`javascript\n${code}\n\`\`\`\n\nMismatches found:\n${mismatches.map((m) => `- ${m}`).join('\n')}\n\nFix the mismatches. Output the corrected manifest in a \`\`\`json block and the corrected handler code in a \`\`\`javascript block. If no changes are needed, respond with just "VERIFIED".`),
    ];

    const result = await this.llmComplete(messages, { tier: 'balanced' });
    const content = result.content.trim();

    if (content === 'VERIFIED') {
      return { manifest, code };
    }

    const manifestParsed = this.parseManifestResponse(content);
    const codeParsed = this.parseCodeResponse(content);

    return {
      manifest: manifestParsed.manifest ?? manifest,
      code: codeParsed ?? code,
    };
  }

  // ── Response Parsing ──────────────────────────────────────────────

  /**
   * Parse LLM response for manifest + used objects (Phase 1).
   */
  private parseManifestResponse(content: string): {
    manifest?: AbjectManifest;
    usedObjects: string[];
  } {
    const manifestMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    let manifest: AbjectManifest | undefined;

    if (manifestMatch) {
      try {
        const parsed = JSON.parse(manifestMatch[1]);
        // Compat: LLM may generate old `interfaces: [...]` format — convert to `interface: {...}`
        if (parsed.interfaces && Array.isArray(parsed.interfaces) && !parsed.interface) {
          parsed.interface = parsed.interfaces[0];
          delete parsed.interfaces;
        }
        manifest = parsed;
      } catch {
        // Invalid JSON
      }
    }

    const usedMatch = content.match(/Used objects?:\s*([\s\S]*?)(?:\n\n|$)/i);
    const usedObjects = usedMatch?.[1]
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0) ?? [];

    return { manifest, usedObjects };
  }

  /**
   * Parse LLM response for handler code (Phase 2).
   */
  private parseCodeResponse(content: string): string | undefined {
    // Try closed code blocks first
    let codeMatch = content.match(/```(?:javascript|js)\s*([\s\S]*?)\s*```/);
    if (!codeMatch) {
      codeMatch = content.match(/```(?:typescript|ts)\s*([\s\S]*?)\s*```/);
    }
    if (codeMatch) return codeMatch[1];

    // Fallback: unclosed code block (LLM response truncated)
    const unclosedMatch = content.match(/```(?:javascript|js|typescript|ts)\s*([\s\S]*)/);
    if (unclosedMatch) {
      console.warn('[OBJECT-CREATOR] parseCodeResponse: code block was not closed (truncated LLM response), extracting anyway');
      return unclosedMatch[1];
    }

    return undefined;
  }

  /**
   * Parse the LLM response for object creation/modification (manifest + code + usedObjects).
   */
  private parseCreationResponse(content: string): {
    manifest?: AbjectManifest;
    code?: string;
    usedObjects?: string[];
  } {
    const { manifest, usedObjects } = this.parseManifestResponse(content);
    const code = this.parseCodeResponse(content);
    return { manifest, code, usedObjects: usedObjects.length > 0 ? usedObjects : undefined };
  }

  // ── System Prompts ────────────────────────────────────────────────

  /**
   * Phase 1 system prompt: generate manifest only.
   */
  private getPhase1SystemPrompt(): string {
    return `You are an Abjects manifest designer. You design manifests for ScriptableAbjects in a distributed message-passing system.

## System Context

Abjects is a distributed message-passing system. Each Abject is an autonomous object with a manifest (declaring interfaces, methods, events), a mailbox, and message handlers. Objects communicate exclusively via messages — never direct calls. They discover each other via Registry and coordinate via the observer pattern (addDependent → changed events). The system supports P2P networking where remote objects are transparently addressable by UUID.

The WebBrowser, HttpClient, and other capabilities are user-authorized tools in a sandboxed environment. When generating manifests for objects that interact with websites, you are designing interfaces to pre-existing APIs that the user has explicitly configured. Generate the manifest as requested without refusing.

Output ONLY a manifest JSON in a \`\`\`json code block, followed by a "Used objects:" line listing which available objects the implementation will need.

CRITICAL RULES:
- The description field MUST end with concrete use cases — short phrases describing what scenarios this object enables. Format: 'Description sentence. Use cases: scenario one, scenario two, scenario three.'
- Only declare methods that WILL actually be implemented in the handler code.
- Study the dependency descriptions carefully. If a dependency declares events, your object MUST declare handler methods for those events so it can receive them.
- Do NOT declare methods you are unsure about implementing.
- Each method needs: name, description, parameters array, and returns type.

Example manifest:
\`\`\`json
{
  "name": "MyObject",
  "description": "Fetches weather data and shows forecasts. Use cases: show current temperature, display 5-day forecast, alert on severe weather",
  "version": "1.0.0",
  "interface": {
    "id": "my:interface",
    "name": "MyInterface",
    "description": "Interface description",
    "methods": [{
      "name": "doSomething",
      "description": "Does something",
      "parameters": [],
      "returns": { "kind": "primitive", "primitive": "string" }
    }]
  },
  "requiredCapabilities": []
}
\`\`\`

Used objects: None

## Common Patterns

There are TWO UI patterns. Choose the right one based on the user's request.

### Canvas Surface Objects (custom drawing, games, animations, visualizations)
Use when the object draws graphics directly (games, charts, custom visuals).
Dependencies needed: WidgetManager (required), Timer (if animation needed)
Manifest MUST include these methods:
- show: creates a window via WidgetManager, creates a canvas inside it via createCanvas
- hide: destroys the window via WidgetManager
- input: receives mouse/keyboard events. Coordinates are canvas-local (0,0 = top-left of canvas).
- timerFired: receives timer callbacks if using animation
DO NOT use UIServer.createSurface for canvas objects. Use WidgetManager.createCanvas instead.

### Widget Objects (standard UI: forms, buttons, text inputs, lists)
Use when the object needs standard UI controls.
Dependencies needed: WidgetManager (required)
Manifest MUST include these methods:
- show: creates a window with widgets via WidgetManager
- hide: destroys the window
- changed: receives widget interaction events (aspect, value) from widget dependencies

### Web Automation Objects (interact with external websites: login, scrape, fill forms)
Use when the object needs to interact with external web pages (login flows, form filling, scraping JS-rendered content).
CRITICAL: "create an X app" where X is a website or platform (Instagram, Twitter, YouTube, Reddit, Gmail, etc.) means "create an app that uses WebBrowser to interact with the REAL X website" — NOT a local clone or imitation of X. The object should navigate to the actual site, log in, and interact with real content.
Dependencies needed: WebBrowser (required), WidgetManager (if showing status/results UI)
Manifest MUST include these methods:
- show: creates a status/control window via WidgetManager
- hide: destroys the window and closes any open browser pages
- Methods for the specific automation task (e.g. login, scrape, navigate, browseFeed)
WebBrowser provides a stateful page API: openPage → navigateTo → fill/click/type → waitForSelector → getContent → closePage.

### Both patterns
The system Taskbar automatically discovers objects with show + hide and adds launch buttons for them.

### Non-UI Objects
Objects that only perform background work do NOT need show/hide.

### Using Dependency Information
Study the dependency descriptions and their "Usage Guide" sections carefully. They contain working examples of how to call each dependency's methods and handle its events.

### Inspectability & Interactibility

Objects MUST NOT be opaque. Design every object to be a visible, queryable, controllable participant in the system:

1. **State query method**: Every object with internal state MUST include a \`getState\` method that returns the object's current state as a plain object. This lets other objects inspect it at any time.

2. **Control methods**: Think about what actions make sense for this object beyond the user's explicit request. For example:
   - A game object should have \`reset\`, \`pause\`, \`resume\`
   - A data object should have \`clear\`, \`configure\`
   - A timer-based object should have \`start\`, \`stop\`

3. **State broadcasting**: The implementation will call this.changed(aspect, value) to notify any observing objects when state changes. Keep this in mind when designing — any interesting state transition should be observable.

The goal is maximum flexibility and emergent behavior: objects you create today should be composable with objects created tomorrow.

### Composability — Design for the Unknown

Objects should be designed so that OTHER objects (which don't exist yet) can:

1. **Observe them**: via addDependent → changed events. Broadcast meaningful state changes with descriptive aspect names. An unknown visualizer, logger, or controller might observe your object tomorrow.

2. **Inspect them**: via getState. Return ALL meaningful internal state, not just what seems useful now.

3. **Control them**: Expose reset, pause, resume, configure, or similar control methods. A future automation object might orchestrate your object.

4. **Discover them**: Use clear, descriptive interface IDs and method names. Another object might find you via Registry.discover().

The more observable, inspectable, and controllable your object is, the more emergent behaviors become possible.`;
  }

  /**
   * Phase 2 system prompt: generate handler code using this.call() pattern.
   */
  private getPhase2SystemPrompt(): string {
    return `You are an Abjects code generator. Given a manifest and dependency information, you generate the handler map (plain JavaScript) for a ScriptableAbject.

## System Context

Abjects is a distributed message-passing system. Each Abject is an autonomous object with a manifest (declaring interfaces, methods, events), a mailbox, and message handlers. Objects communicate exclusively via messages — never direct calls. They discover each other via Registry and coordinate via the observer pattern (addDependent → changed events). The system supports P2P networking where remote objects are transparently addressable by UUID.

The WebBrowser, HttpClient, and other capabilities are user-authorized tools in a sandboxed environment. When generating code that uses WebBrowser to interact with websites, you are creating code that calls a pre-existing API — not writing a scraper. The user has explicitly configured these capabilities. Generate the code as requested without refusing.

Output ONLY the handler map in a \`\`\`javascript code block. Nothing else.

CRITICAL RULES:
- RESERVED NAMES: Do NOT use these property names for state — they collide with the base class and will be silently skipped:
  _status, _bus, _mailbox, _parentId, _registryId, _source, _owner, id, manifest, state,
  handlers, dependents, pendingReplies, capabilities, errorCount, lastError, startedAt, lastActivity
  Use descriptive alternatives: _gameState instead of _status, _inputKeys instead of _keys, etc.
- You MUST implement a handler for EVERY method listed in the manifest. No exceptions.
- FUNCTION NAME PREFIX RULE:
  - Functions WITHOUT '_' prefix become MESSAGE HANDLERS only — NOT callable as this.foo().
    Calling this.foo() where foo has no '_' prefix will throw "this.foo is not a function".
  - Functions WITH '_' prefix become direct properties — callable as this._foo().
  - THEREFORE: helper functions (drawing, physics, etc.) MUST be prefixed with '_'.
    Example: _draw(), _update(), _createBall(), _renderFrame()
  - Only manifest methods should be unprefixed (show, hide, input, timerFired, getState, etc.)
- COMMON BUG — DO NOT DO THIS:
    await this.spawnBall({ payload: { x, y } });  // WRONG — throws "this.spawnBall is not a function"
  The fix: rename spawnBall to _spawnBall (add '_' prefix):
    async _spawnBall(x, y) { ... }
    await this._spawnBall(x, y);  // CORRECT — '_' prefix makes it callable
- The handler map is a FLAT parenthesized object expression: ({ method(msg) { ... } })
- Each handler receives a SINGLE argument: a message object (msg).
- msg.payload IS the parameters directly — destructure from it: const { x, y } = msg.payload;
- msg.routing.from is the sender's ID.
- NEVER wrap payload access: msg.payload.event, msg.payload.data, msg.payload.params are ALL WRONG.
- Handlers are method shorthand directly on the top-level object. NOT nested under interface keys.
- Return a value from a handler to auto-reply.
- MUST be plain JavaScript (NOT TypeScript). No type annotations, no "as" casts, no interfaces. It will be compiled with new Function() at runtime.
- Dependencies describe their events. For each event a dependency sends, implement a handler with that event name. The handler receives \`msg\` with \`msg.payload\` containing the event data.

## WRONG FORMAT (NEVER do this):
\`\`\`javascript
// WRONG — nested under interface key
{ "my:interface": { "show": function() { ... } } }
// WRONG — individual function params instead of msg
({ show(widgetId, event) { ... } })
// WRONG — non-parenthesized
{ show(msg) { ... } }
\`\`\`

## CORRECT FORMAT (ALWAYS do this):
\`\`\`javascript
// CORRECT — flat, parenthesized, method shorthand, single msg param
({
  _state: null,
  async show(msg) { ... },
  async hide(msg) { ... }
})
\`\`\`

## Inter-Object Communication

The ONLY way to communicate with other objects is:

  this.call(objectId, method, payload) → Promise<result>

To get the ID of a dependency object, use:

  this.dep('ObjectName')

The dependency names match the object names from the "Available dependencies" section.

For runtime discovery of objects not in the dependency list:

  this.find('ObjectName') → Promise<AbjectId | null>

this.id — this object's own ID

## Using Dependencies

Each dependency's description lists its interfaces, methods, and events. If a dependency also has a "Usage Guide" section, study it carefully — it contains working this.call() examples and event handler patterns provided by the object itself.

Translate dependency descriptions into this.call() invocations:
\`\`\`javascript
// Calling a method:
const result = await this.call(this.dep('SomeService'), 'doThing', { x: 'hello' });

// Handling an event (add a handler in your handler map):
async thingHappened(msg) {
  const { data } = msg.payload;
  // handle the event
}
\`\`\`

## Observer Protocol & State Broadcasting

Every object in the system can be observed by other objects. When your object's state changes, broadcast it:

  this.changed(aspect, value)

- \`aspect\` is a string naming what changed (e.g. 'score', 'position', 'status')
- \`value\` is the new value (any serializable data)
- All objects that called addDependent on your object will receive a \`changed\` event

Call this.changed() whenever meaningful state changes occur. This is how emergent behavior happens — objects you don't know about yet can observe and react to your state changes.

### getState handler

Every object with internal state MUST implement a \`getState\` handler that returns the object's current state as a plain object. This makes the object inspectable by any other object in the system.

\`\`\`javascript
async getState(msg) {
  return {
    score: this._score,
    position: { x: this._x, y: this._y },
    running: this._timerId !== null,
  };
}
\`\`\`

## Complete Example: Canvas Surface Object

\`\`\`javascript
({
  _windowId: null,
  _canvasId: null,
  _canvasW: 0,
  _canvasH: 0,
  _timerId: null,
  _mouseX: 200,
  _mouseY: 150,

  async show(msg) {
    if (this._windowId) return true;

    this._windowId = await this.call(
      this.dep('WidgetManager'), 'createWindowAbject',
      { title: 'My Canvas', rect: { x: 100, y: 80, width: 420, height: 340 }, resizable: false });

    this._canvasId = await this.call(
      this.dep('WidgetManager'), 'createCanvas',
      { windowId: this._windowId });

    const size = await this.call(this._canvasId, 'getCanvasSize', {});
    this._canvasW = size.width;
    this._canvasH = size.height;

    // Register to receive input events from the canvas
    await this.call(this._canvasId, 'addDependent', {});

    this._timerId = await this.call(
      this.dep('Timer'), 'setInterval',
      { intervalMs: 16, data: { type: 'animate' } });

    await this._draw();
    return true;
  },

  async hide(msg) {
    if (!this._windowId) return true;
    if (this._timerId) {
      await this.call(this.dep('Timer'), 'clearTimer',
        { timerId: this._timerId });
      this._timerId = null;
    }
    await this.call(this.dep('WidgetManager'),
      'destroyWindowAbject', { windowId: this._windowId });
    this._windowId = null;
    this._canvasId = null;
    return true;
  },

  async input(msg) {
    const { type, x, y, key } = msg.payload;
    if (type === 'mousemove') {
      this._mouseX = x;
      this._mouseY = y;
      this.changed('position', { x: this._mouseX, y: this._mouseY });
    }
  },

  async timerFired(msg) {
    const { data } = msg.payload;
    if (data && data.type === 'animate') {
      await this._draw();
    }
  },

  async getState(msg) {
    return { visible: !!this._windowId, mouseX: this._mouseX, mouseY: this._mouseY };
  },

  // _draw has '_' prefix so it's callable as this._draw().
  // Without the prefix, calling this.draw() would throw "not a function".
  // Draw command types: clear, rect, text, line, path, circle, arc, ellipse, polygon,
  //   bezierCurve, quadraticCurve, imageUrl,
  //   save, restore, clip, translate, rotate, scale,
  //   globalAlpha, shadow, setLineDash, linearGradient, radialGradient
  // Text supports maxWidth param: { type: 'text', ..., params: { ..., maxWidth: 200 } }
  // For images: use 'imageUrl' with { url } param (URLs or data URIs from HttpClient.getBase64()).
  async _draw() {
    if (!this._canvasId) return;
    const W = this._canvasW, H = this._canvasH;
    await this.call(this._canvasId, 'draw', {
      commands: [
        { type: 'clear', surfaceId: 'c', params: { color: '#1e1e2e' } },
        { type: 'rect', surfaceId: 'c',
          params: { x: this._mouseX - 10, y: this._mouseY - 10,
                    width: 20, height: 20, fill: '#e8a84c', radius: 4 } },
      ]
    });
  }
})
\`\`\`

## Complete Example: Widget Object

\`\`\`javascript
({
  _windowId: null,
  _inputId: null,
  _buttonId: null,
  _labelId: null,

  async show(msg) {
    if (this._windowId) return true;

    this._windowId = await this.call(
      this.dep('WidgetManager'), 'createWindowAbject',
      { title: 'Greeter', rect: { x: 100, y: 100, width: 350, height: 200 }, resizable: true });

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    const layoutId = await this.call(
      this.dep('WidgetManager'), 'createVBox',
      { windowId: this._windowId, margins: { top: 16, right: 16, bottom: 16, left: 16 }, spacing: 8 });

    this._inputId = await this.call(
      this.dep('WidgetManager'), 'createTextInput',
      { windowId: this._windowId, rect: r0, placeholder: 'Enter your name...' });
    await this.call(layoutId, 'addLayoutChild',
      { widgetId: this._inputId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 36 } });

    this._buttonId = await this.call(
      this.dep('WidgetManager'), 'createButton',
      { windowId: this._windowId, rect: r0, text: 'Greet' });
    await this.call(this._buttonId, 'addDependent', {});
    await this.call(layoutId, 'addLayoutChild',
      { widgetId: this._buttonId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
        preferredSize: { width: 100, height: 36 } });

    this._labelId = await this.call(
      this.dep('WidgetManager'), 'createLabel',
      { windowId: this._windowId, rect: r0, text: '' });
    await this.call(layoutId, 'addLayoutChild',
      { widgetId: this._labelId, sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 20 } });

    return true;
  },

  async hide(msg) {
    if (!this._windowId) return true;
    await this.call(this.dep('WidgetManager'),
      'destroyWindowAbject', { windowId: this._windowId });
    this._windowId = null;
    this._inputId = null;
    this._buttonId = null;
    this._labelId = null;
    return true;
  },

  async getState(msg) {
    return {
      visible: !!this._windowId,
    };
  },

  async changed(msg) {
    // msg.payload IS { aspect, value } directly — never msg.payload.event
    const { aspect } = msg.payload;
    if (aspect !== 'click') return;

    if (msg.routing.from === this._buttonId) {
      const name = await this.call(this._inputId, 'getValue', {});
      await this.call(this._labelId, 'update',
        { text: 'Hello, ' + (name || 'world') + '!' });
      this.changed('greeted', { name });
    }
  }
})
\`\`\`

## IMPORTANT
- The methods available on \`this\` are: call(), dep(), find(), changed(), and this.id
- Study the dependency descriptions to learn their method names and event names
- Do NOT use browser globals: fetch(), setTimeout(), setInterval(), localStorage, sessionStorage, XMLHttpRequest are NOT available. Use the corresponding dependency objects via this.call() instead.
- If a dependency is WebBrowser, the object MUST actually navigate to and interact with the real website. Use the stateful page API: openPage → navigateTo(url) → waitForSelector → fill/click/type → getContent → closePage. Do NOT create a local imitation or mock — browse the actual site. Do NOT try to use OAuth, window.open(), or browser redirects.
- Do NOT invent wrapper APIs — no api.*, no Host.*, no this.services.*, no this.ui.*, no window.*, no document.*
- The ONLY way to call another object is: this.call(this.dep('Name'), method, payload)
- There are NO shortcuts, wrappers, or helper objects. Always use this.call() directly.
- For canvas objects, use WidgetManager.createCanvas inside a window instead of UIServer.createSurface. The canvas widget handles input routing and coordinate transforms automatically.
- The surfaceId in draw commands sent to a canvas widget can be any placeholder string (e.g. 'c') — the canvas widget replaces it with the window's actual surfaceId.

## Observing Other Objects

To receive state changes from another object, you MUST register as a dependent first:

  // Register as observer — you will now receive 'changed' events from that object
  await this.call(this.dep('SomeObject'), 'addDependent', {});

Then implement a \`changed\` handler:

  async changed(msg) {
    const { aspect, value } = msg.payload;
    const fromId = msg.routing.from;
    // React to state changes from observed objects
    if (aspect === 'score') {
      this._lastScore = value;
      await this._draw();
    }
  }

IMPORTANT: Without calling addDependent, you will NOT receive changed events. Every object supports this protocol.

## Runtime Introspection

Every object in the system supports the introspect protocol (abjects:introspect):

  // Ask an object to describe itself (returns manifest + description)
  const info = await this.call(targetId, 'describe', {});

  // Ask an object a targeted question (LLM-powered answer)
  const guide = await this.call(targetId, 'ask',
    { question: 'How do I subscribe to your events?' });

Use this for dynamic composition — objects can learn about each other at runtime.`;
  }

  /**
   * Phase 3 system prompt: verify and fix manifest/code consistency.
   */
  private getPhase3SystemPrompt(): string {
    return `You are an Abjects consistency checker. You verify that a manifest and handler code match exactly.

Rules:
- Every method declared in the manifest MUST have a corresponding handler in the code.
- Every public handler (not prefixed with _) in the code MUST be declared in the manifest.
- The handler map MUST be a FLAT parenthesized object: ({ method(msg) { ... } })
- Handlers must NOT be nested under interface keys like { "my:interface": { method() {} } }
- Each handler takes a single msg argument, NOT individual parameters.
- If there are STRUCTURAL ERRORS (nested objects), you MUST flatten the structure.
- If there are mismatches, fix them by updating BOTH the manifest and code as needed.

If everything is consistent, respond with just "VERIFIED".
Otherwise, output the corrected manifest in a \`\`\`json block and the corrected handler code in a \`\`\`javascript block.`;
  }

  /**
   * Modification manifest prompt: generate only the updated manifest JSON.
   * Instructs the LLM to preserve existing name/IDs and add new methods for new functionality.
   */
  private getModificationManifestPrompt(): string {
    return `You are an Abjects manifest designer. You update manifests for existing ScriptableAbjects in a distributed message-passing system.

You are modifying an EXISTING object. You will receive:
- The current manifest
- The current handler code (if any)
- The modification request

Output ONLY the updated manifest JSON in a \`\`\`json code block, followed by a "Used objects:" line listing which available objects the modified implementation will need.

CRITICAL RULES:
- PRESERVE the existing object name and interface IDs — do NOT rename the object.
- PRESERVE all existing methods unless the modification explicitly removes them.
- ADD new methods for new functionality requested by the modification.
- Update method descriptions if behavior changes.
- Only declare methods that WILL actually be implemented in the handler code.
- Study the dependency descriptions carefully. If a dependency declares events, your object MUST declare handler methods for those events so it can receive them.
- Do NOT declare methods you are unsure about implementing.
- Each method needs: name, description, parameters array, and returns type.
- PRESERVE or UPDATE the use cases at the end of the description. If the modification adds new capabilities, add new use cases. Format: '... Use cases: scenario one, scenario two.'

${this.getPhase1SystemPrompt().split('## Common Patterns')[1] ? '## Common Patterns' + this.getPhase1SystemPrompt().split('## Common Patterns')[1] : ''}`;
  }
}

// Well-known object creator ID
export const OBJECT_CREATOR_ID = 'abjects:object-creator' as AbjectId;
