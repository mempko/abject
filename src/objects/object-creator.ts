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
import { Abject } from '../core/abject.js';
import { require } from '../core/contracts.js';
import { request, event } from '../core/message.js';
import { INTROSPECT_INTERFACE_ID, IntrospectResult } from '../core/introspect.js';

import { ScriptableAbject } from './scriptable-abject.js';
import { systemMessage, userMessage, LLMMessage, LLMCompletionResult, LLMCompletionOptions } from '../llm/provider.js';


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
  private factoryId?: AbjectId;
  private negotiatorId?: AbjectId;

  constructor() {
    super({
      manifest: {
        name: 'ObjectCreator',
        description:
          'Create and modify objects using natural language. Discovers existing objects and generates new ones that compose with them.',
        version: '1.0.0',
        interfaces: [
          {
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
        ],
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
      return this.createObject(prompt, context, msg.routing.from);
    });

    this.on('modify', async (msg: AbjectMessage) => {
      const { objectId, prompt } = msg.payload as ModifyObjectRequest;
      return this.modifyObject(objectId, prompt);
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
  }

  protected override async onInit(): Promise<void> {
    this.llmId = await this.requireDep('LLM');
    this.registryId = await this.requireDep('Registry');
    this.factoryId = await this.requireDep('Factory');
    this.negotiatorId = await this.requireDep('Negotiator');
  }

  /**
   * Call LLM complete via message passing.
   */
  private async llmComplete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult> {
    return this.request<LLMCompletionResult>(
      request(this.id, this.llmId!, 'abjects:llm' as InterfaceId, 'complete', { messages, options }),
      120000
    );
  }

  /**
   * List objects from registry via message passing.
   */
  private async registryList(): Promise<ObjectRegistration[]> {
    return this.request<ObjectRegistration[]>(
      request(this.id, this.registryId!, 'abjects:registry' as InterfaceId, 'list', {})
    );
  }

  /**
   * Look up an object in the registry via message passing.
   */
  private async registryLookup(objectId: AbjectId): Promise<ObjectRegistration | null> {
    return this.request<ObjectRegistration | null>(
      request(this.id, this.registryId!, 'abjects:registry' as InterfaceId, 'lookup', { objectId })
    );
  }

  /**
   * Get object source from registry via message passing.
   */
  private async registryGetSource(objectId: AbjectId): Promise<string | null> {
    return this.request<string | null>(
      request(this.id, this.registryId!, 'abjects:registry' as InterfaceId, 'getSource', { objectId })
    );
  }

  /**
   * Spawn an object via factory message passing.
   */
  private async factorySpawn(spawnReq: SpawnRequest): Promise<SpawnResult> {
    return this.request<SpawnResult>(
      request(this.id, this.factoryId!, 'abjects:factory' as InterfaceId, 'spawn', spawnReq)
    );
  }

  private async reportProgress(callerId: AbjectId, phase: string, message: string): Promise<void> {
    try {
      await this.send(
        event(this.id, callerId, OBJECT_CREATOR_INTERFACE, 'progress', { phase, message })
      );
    } catch { /* best-effort */ }
  }

  // ── Multi-Phase Discovery Pipeline ────────────────────────────────

  /**
   * Phase 0a: Get summaries (name + description) of all registered objects.
   */
  private async discoverObjectSummaries(): Promise<ObjectSummary[]> {
    if (!this.registryId) return [];
    const allObjects = await this.registryList();
    return allObjects.map((o) => ({
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
        'Study each object\'s description to determine if the new object needs its methods or will receive its events. ' +
        'Return one name per line, nothing else. If no dependencies are needed, return "None".'
      ),
      userMessage(`Available objects:\n${summaryText}\n\nNew object to create: ${prompt}\n\nWhich objects does it need?`),
    ], { tier: 'balanced' });

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
        request(this.id, objectId, INTROSPECT_INTERFACE_ID, 'describe', {})
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
        request(this.id, objectId, INTROSPECT_INTERFACE_ID, 'ask', { question }),
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
        let text = `## ${dep.name} (id available as this.dep('${dep.name}'))\n${dep.description}\n\n  Usage: this.call(this.dep('${dep.name}'), interfaceId, methodName, payload)`;
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
      const deps = await this.fetchFullManifests(selectedNames, summaries);
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
          console.log(`[OBJECT-CREATOR] Retry ${attempt}/${MAX_CODE_ATTEMPTS}: regenerating code`);
          code = await this.regenerateHandlerCode(
            manifest, prompt, depContext, phase1.usedObjects, code ?? '', lastError, context
          );
        }
        if (!code) {
          lastError = 'Failed to generate handler code';
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
            manifest = llmFixed.manifest;
            code = llmFixed.code;
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
        });

        // Phase 6: Connect to dependencies via Negotiator (fire-and-forget)
        if (callerId && deps.length > 0) {
          const connectNames = deps.map((d) => d.name).join(', ');
          await this.reportProgress(callerId, '6', `Connecting to ${connectNames}...`);
        }
        if (this.negotiatorId && spawnResult.objectId) {
          for (const dep of deps) {
            this.request(request(
              this.id, this.negotiatorId,
              'abjects:negotiator' as InterfaceId, 'connect',
              { sourceId: spawnResult.objectId, targetId: dep.id }
            )).catch((err) => {
              console.warn(`[OBJECT-CREATOR] Connect to ${dep.name} failed:`, err);
            });
          }
        }

        return {
          success: true,
          objectId: spawnResult.objectId,
          manifest,
          code,
          usedObjects: phase1.usedObjects,
        };
      }

      return {
        success: true,
        manifest,
        code,
        usedObjects: phase1.usedObjects,
      };
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Modify an existing object.
   */
  async modifyObject(objectId: AbjectId, prompt: string): Promise<CreationResult> {
    require(this.llmId !== undefined, 'LLM not set');
    require(this.registryId !== undefined, 'Registry not set');

    const registration = await this.registryLookup(objectId);
    if (!registration) {
      return { success: false, error: 'Object not found' };
    }

    const currentSource = await this.registryGetSource(objectId);

    try {
      // Get dependency context for modification
      const summaries = await this.discoverObjectSummaries();
      const selectedNames = await this.llmSelectDependencies(prompt, summaries);
      const deps = await this.fetchFullManifests(selectedNames, summaries);
      const usageGuides = await this.fetchUsageGuides(deps);
      const depContext = this.formatFullManifestContext(deps, usageGuides);

      const sourceBlock = currentSource
        ? `\nCurrent handler source:\n\`\`\`javascript\n${currentSource}\n\`\`\`\n`
        : '';

      const messages: LLMMessage[] = [
        systemMessage(this.getModificationSystemPrompt()),
        userMessage(`Available dependencies:\n${depContext}\n\nCurrent manifest:
\`\`\`json
${JSON.stringify(registration.manifest, null, 2)}
\`\`\`
${sourceBlock}
Modification request: ${prompt}

Generate the updated manifest and handler map that implements this change.`),
      ];

      const result = await this.llmComplete(messages, { tier: 'smart' });
      const parsed = this.parseCreationResponse(result.content);

      return {
        success: true,
        objectId,
        manifest: parsed.manifest,
        code: parsed.code,
      };
    } catch (err) {
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
    const methodList = manifest.interfaces
      .flatMap((i) => i.methods.map((m) => m.name));

    const messages: LLMMessage[] = [
      systemMessage(this.getPhase2SystemPrompt()),
      userMessage(`Manifest:\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\nYou MUST implement handlers for these methods: ${methodList.join(', ')}\n\nAvailable dependencies:\n${depContext}\n\nUsed objects: ${usedObjects.length > 0 ? usedObjects.join(', ') : 'None'}\n\n${context ? `Additional context: ${context}\n\n` : ''}Original user request: ${prompt}\n\nGenerate the handler map.`),
    ];

    const result = await this.llmComplete(messages, { tier: 'balanced' });
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
    const methodList = manifest.interfaces
      .flatMap((i) => i.methods.map((m) => m.name));

    const messages: LLMMessage[] = [
      systemMessage(this.getPhase2SystemPrompt()),
      userMessage(`Manifest:\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\nYou MUST implement handlers for these methods: ${methodList.join(', ')}\n\nAvailable dependencies:\n${depContext}\n\nUsed objects: ${usedObjects.length > 0 ? usedObjects.join(', ') : 'None'}\n\n${context ? `Additional context: ${context}\n\n` : ''}Original user request: ${prompt}\n\nGenerate the handler map.`),
      systemMessage(`Your previous attempt failed with this error:\n${errorFeedback}\n\n${previousCode ? `Previous code:\n\`\`\`javascript\n${previousCode}\n\`\`\`\n\n` : ''}Fix these issues. Remember:\n- The handler map MUST be a FLAT parenthesized object: ({ method(msg) { ... } })\n- You MUST implement ALL methods listed above: ${methodList.join(', ')}\n- Each handler takes a single msg argument\n- MUST be plain JavaScript, NOT TypeScript\n- Do NOT nest handlers under interface keys\n\nGenerate the corrected handler map.`),
    ];

    const result = await this.llmComplete(messages, { tier: 'balanced' });
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
      manifest.interfaces.flatMap((i) => i.methods.map((m) => m.name))
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
        manifest = JSON.parse(manifestMatch[1]);
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
    let codeMatch = content.match(/```(?:javascript|js)\s*([\s\S]*?)\s*```/);
    if (!codeMatch) {
      codeMatch = content.match(/```(?:typescript|ts)\s*([\s\S]*?)\s*```/);
    }
    return codeMatch?.[1];
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

Output ONLY a manifest JSON in a \`\`\`json code block, followed by a "Used objects:" line listing which available objects the implementation will need.

CRITICAL RULES:
- Only declare methods that WILL actually be implemented in the handler code.
- Study the dependency descriptions carefully. If a dependency declares events, your object MUST declare handler methods for those events so it can receive them.
- Do NOT declare methods you are unsure about implementing.
- Each method needs: name, description, parameters array, and returns type.

Example manifest:
\`\`\`json
{
  "name": "MyObject",
  "description": "Does something useful",
  "version": "1.0.0",
  "interfaces": [{
    "id": "my:interface",
    "name": "MyInterface",
    "description": "Interface description",
    "methods": [{
      "name": "doSomething",
      "description": "Does something",
      "parameters": [],
      "returns": { "kind": "primitive", "primitive": "string" }
    }]
  }],
  "requiredCapabilities": []
}
\`\`\`

Used objects: None

## Common Patterns

There are TWO UI patterns. Choose the right one based on the user's request.

### Canvas Surface Objects (custom drawing, games, animations, visualizations)
Use when the object draws graphics directly (games, charts, custom visuals).
Dependencies needed: UIServer (required), Timer (if animation needed)
Manifest MUST include these methods:
- show: creates a canvas surface via UIServer and starts rendering
- hide: destroys the surface and stops timers
- input: receives mouse/keyboard events from UIServer. Handler signature is \`async input(msg)\`.
  msg.payload contains: { type, surfaceId, x, y, button, key, code, modifiers }
- timerFired: receives timer callbacks if using animation. Handler signature is \`async timerFired(msg)\`.
  msg.payload contains: { timerId, data }
- If your object does NOT need mouse/keyboard input (e.g. it reacts to other objects' state), set inputPassthrough: true when creating the surface. This lets input events pass through to surfaces behind it.
- If your object needs to track the mouse globally (e.g. cursor-following overlay, full-screen visual effect) without blocking clicks on windows behind it, set BOTH inputPassthrough: true AND inputMonitor: true. The surface will receive a copy of all mouse/wheel events in surface-local coordinates.

### Widget Objects (standard UI: forms, buttons, text inputs, lists)
Use when the object needs standard UI controls.
Dependencies needed: WidgetManager (required)
Manifest MUST include these methods:
- show: creates a window with widgets via WidgetManager
- hide: destroys the window
- changed: receives widget interaction events (aspect, value) from widget dependencies

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

The goal is maximum flexibility and emergent behavior: objects you create today should be composable with objects created tomorrow.`;
  }

  /**
   * Phase 2 system prompt: generate handler code using this.call() pattern.
   */
  private getPhase2SystemPrompt(): string {
    return `You are an Abjects code generator. Given a manifest and dependency information, you generate the handler map (plain JavaScript) for a ScriptableAbject.

Output ONLY the handler map in a \`\`\`javascript code block. Nothing else.

CRITICAL RULES:
- You MUST implement a handler for EVERY method listed in the manifest. No exceptions.
- FUNCTION NAME PREFIX RULE:
  - Functions WITHOUT '_' prefix become MESSAGE HANDLERS only — NOT callable as this.foo().
    Calling this.foo() where foo has no '_' prefix will throw "this.foo is not a function".
  - Functions WITH '_' prefix become direct properties — callable as this._foo().
  - THEREFORE: helper functions (drawing, physics, etc.) MUST be prefixed with '_'.
    Example: _draw(), _update(), _createBall(), _renderFrame()
  - Only manifest methods should be unprefixed (show, hide, input, timerFired, getState, etc.)
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

  this.call(objectId, interfaceId, method, payload) → Promise<result>

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
const result = await this.call(this.dep('SomeService'), 'abjects:some-service', 'doThing', { x: 'hello' });

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
  _surfaceId: null,
  _timerId: null,
  _mouseX: 200,
  _mouseY: 150,

  async show(msg) {
    if (this._surfaceId) return true;

    const { width, height } = await this.call(
      this.dep('UIServer'), 'abjects:ui', 'getDisplayInfo', {});

    this._surfaceId = await this.call(
      this.dep('UIServer'), 'abjects:ui', 'createSurface',
      { rect: { x: 50, y: 50, width: 400, height: 300 }, zIndex: 100 });

    this._timerId = await this.call(
      this.dep('Timer'), 'abjects:timer', 'setInterval',
      { intervalMs: 16, data: { type: 'animate' } });

    await this._draw();
    return true;
  },

  async hide(msg) {
    if (!this._surfaceId) return true;
    if (this._timerId) {
      await this.call(this.dep('Timer'), 'abjects:timer', 'clearTimer',
        { timerId: this._timerId });
      this._timerId = null;
    }
    await this.call(this.dep('UIServer'), 'abjects:ui', 'destroySurface',
      { surfaceId: this._surfaceId });
    this._surfaceId = null;
    return true;
  },

  async input(msg) {
    // msg.payload IS the event directly — never msg.payload.event
    const { type, x, y, key } = msg.payload;
    if (type === 'mousemove') {
      this._mouseX = x;
      this._mouseY = y;
      this.changed('position', { x: this._mouseX, y: this._mouseY });
    }
  },

  async getState(msg) {
    return {
      mouseX: this._mouseX,
      mouseY: this._mouseY,
      visible: !!this._surfaceId,
    };
  },

  async timerFired(msg) {
    // msg.payload IS { timerId, data } directly
    const { data } = msg.payload;
    if (data && data.type === 'animate') {
      await this._draw();
    }
  },

  // _draw has '_' prefix so it's callable as this._draw().
  // Without the prefix, calling this.draw() would throw "not a function".
  async _draw() {
    if (!this._surfaceId) return;
    await this.call(this.dep('UIServer'), 'abjects:ui', 'draw', {
      commands: [
        { type: 'clear', surfaceId: this._surfaceId, params: {} },
        { type: 'rect', surfaceId: this._surfaceId,
          params: { x: 0, y: 0, width: 400, height: 300, fill: '#1e1e2e' } },
        { type: 'rect', surfaceId: this._surfaceId,
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
      this.dep('WidgetManager'), 'abjects:widgets', 'createWindowAbject',
      { title: 'Greeter', rect: { x: 100, y: 100, width: 350, height: 200 }, resizable: true });

    const r0 = { x: 0, y: 0, width: 0, height: 0 };

    const layoutId = await this.call(
      this.dep('WidgetManager'), 'abjects:widgets', 'createVBox',
      { windowId: this._windowId, margins: { top: 16, right: 16, bottom: 16, left: 16 }, spacing: 8 });

    this._inputId = await this.call(
      this.dep('WidgetManager'), 'abjects:widgets', 'createTextInput',
      { windowId: this._windowId, rect: r0, placeholder: 'Enter your name...' });
    await this.call(layoutId, 'abjects:layout', 'addLayoutChild',
      { widgetId: this._inputId, sizePolicy: { vertical: 'fixed', horizontal: 'expanding' },
        preferredSize: { height: 36 } });

    this._buttonId = await this.call(
      this.dep('WidgetManager'), 'abjects:widgets', 'createButton',
      { windowId: this._windowId, rect: r0, text: 'Greet' });
    await this.call(this._buttonId, 'abjects:introspect', 'addDependent', {});
    await this.call(layoutId, 'abjects:layout', 'addLayoutChild',
      { widgetId: this._buttonId, sizePolicy: { horizontal: 'fixed', vertical: 'fixed' },
        preferredSize: { width: 100, height: 36 } });

    this._labelId = await this.call(
      this.dep('WidgetManager'), 'abjects:widgets', 'createLabel',
      { windowId: this._windowId, rect: r0, text: '' });
    await this.call(layoutId, 'abjects:layout', 'addLayoutChild',
      { widgetId: this._labelId, sizePolicy: { vertical: 'fixed' },
        preferredSize: { height: 20 } });

    return true;
  },

  async hide(msg) {
    if (!this._windowId) return true;
    await this.call(this.dep('WidgetManager'), 'abjects:widgets',
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
      const name = await this.call(this._inputId, 'abjects:widget', 'getValue', {});
      await this.call(this._labelId, 'abjects:widget', 'update',
        { text: 'Hello, ' + (name || 'world') + '!' });
      this.changed('greeted', { name });
    }
  }
})
\`\`\`

## IMPORTANT
- The methods available on \`this\` are: call(), dep(), find(), changed(), and this.id
- Study the dependency descriptions to learn their interface IDs, method names, and event names
- Do NOT invent wrapper APIs — no api.*, no Host.*, no this.services.*, no this.ui.*, no window.*, no document.*
- The ONLY way to call another object is: this.call(this.dep('Name'), interfaceId, method, payload)
- There are NO shortcuts, wrappers, or helper objects. Always use this.call() directly.
- When creating a display-only surface (no input needed), pass inputPassthrough: true to createSurface. This prevents your surface from stealing input from surfaces behind it.
- For cursor-following overlays that need mouse events without blocking clicks, pass BOTH inputPassthrough: true AND inputMonitor: true. The surface receives a copy of all mouse/wheel events (in surface-local coords) before normal routing.`;
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
   * Get the system prompt for object modification.
   */
  private getModificationSystemPrompt(): string {
    return `You are an Abjects object modifier. You update existing handler maps while preserving core functionality.

When modifying objects:
1. Preserve the object's ID and registration
2. Update the manifest if interfaces change
3. Maintain backward compatibility where possible

Output format:
1. Output the updated manifest as JSON in a \`\`\`json code block
2. Output the updated handler map as JavaScript in a \`\`\`javascript code block
   The handler map is a parenthesized object expression: ({ method(msg) { ... } })

## Inter-Object Communication

The ONLY way to communicate with other objects is:

  this.call(objectId, interfaceId, method, payload) → Promise<result>

To get the ID of a dependency:

  this.dep('ObjectName')

this.id — this object's own ID

The ONLY methods available on \`this\` are: call(), dep(), find(), and this.id.
Study the dependency descriptions to learn their interface IDs, method names, and parameters.
Do NOT invent methods — no Host.*, no this.services.*, no this.ui.*
ALL interaction with dependencies MUST go through this.call(this.dep('Name'), interfaceId, method, payload).

## Message Handling Rules
- msg.payload IS the data directly. Destructure: const { x, y } = msg.payload;
- msg.routing.from is the sender's ID.
- NEVER use nested access like msg.payload.event, msg.payload.data, or msg.payload.params.
- For input events: const { type, surfaceId, x, y, key } = msg.payload;
- For timer events: const { timerId, data } = msg.payload;
- For widget changed events: const { aspect, value } = msg.payload;

## Observer Protocol
- this.changed(aspect, value) broadcasts state changes to all observing objects.
- Call it whenever meaningful state changes: this.changed('score', newScore)
- Always include a getState handler that returns the object's current internal state.
- Objects should be inspectable and interactible, not opaque.`;
  }
}

// Well-known object creator ID
export const OBJECT_CREATOR_ID = 'abjects:object-creator' as AbjectId;
