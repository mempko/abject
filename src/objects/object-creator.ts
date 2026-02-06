/**
 * Object Creator - user-facing object for creating and modifying objects via natural language.
 *
 * Uses a multi-phase pipeline:
 *   Phase 0a: discoverObjectSummaries() — registry.list() → name + description
 *   Phase 0b: llmSelectDependencies()   — LLM picks relevant objects from summaries
 *   Phase 0c: fetchFullManifests()       — registry.lookup() for selected objects
 *   Phase 1:  generateManifest()         — LLM designs manifest with full dependency context
 *   Phase 2:  generateHandlerCode()      — LLM generates this.call() code
 *   Phase 3:  verifyAndFix()             — programmatic consistency check
 *   Phase 3b: llmVerifyAndFix()          — optional LLM-assisted fix
 *   Phase 4:  compile check
 *   Phase 5:  factory.spawn({ ..., deps })
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
import { request } from '../core/message.js';
import { INTROSPECT_INTERFACE_ID, IntrospectResult } from '../core/introspect.js';

import { ScriptableAbject } from './scriptable-abject.js';
import { systemMessage, userMessage, LLMMessage, LLMCompletionResult } from '../llm/provider.js';


const OBJECT_CREATOR_INTERFACE = 'abjects:object-creator';

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
      return this.createObject(prompt, context);
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

  /**
   * Set dependencies via AbjectIds for message passing.
   */
  setDependencies(llmId: AbjectId, registryId: AbjectId, factoryId: AbjectId, negotiatorId?: AbjectId): void {
    this.llmId = llmId;
    this.registryId = registryId;
    this.factoryId = factoryId;
    this.negotiatorId = negotiatorId;
  }

  /**
   * Call LLM complete via message passing.
   */
  private async llmComplete(messages: LLMMessage[]): Promise<LLMCompletionResult> {
    return this.request<LLMCompletionResult>(
      request(this.id, this.llmId!, 'abjects:llm' as InterfaceId, 'complete', { messages })
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
    ]);

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
   * Format full manifest context for LLM prompts using introspect descriptions.
   * Objects describe themselves — no manual formatting needed.
   */
  private formatFullManifestContext(deps: SelectedDependency[]): string {
    if (deps.length === 0) return 'None';

    return deps
      .map((dep) => {
        return `## ${dep.name} (id available as this.dep('${dep.name}'))\n${dep.description}\n\n  Usage: this.call(this.dep('${dep.name}'), interfaceId, methodName, payload)`;
      })
      .join('\n\n---\n\n');
  }

  // ── Object Creation ───────────────────────────────────────────────

  /**
   * Create a new object from a natural language prompt.
   * Uses multi-phase pipeline: discovery → manifest → code → verify → spawn.
   */
  async createObject(prompt: string, context?: string): Promise<CreationResult> {
    require(this.llmId !== undefined, 'LLM not set');
    require(this.registryId !== undefined, 'Registry not set');

    try {
      // Phase 0a: Get object summaries
      const summaries = await this.discoverObjectSummaries();

      // Phase 0b: LLM selects dependencies
      const selectedNames = await this.llmSelectDependencies(prompt, summaries);
      console.log('[OBJECT-CREATOR] Selected dependencies:', selectedNames);

      // Phase 0c: Fetch full manifests for selected dependencies
      const deps = await this.fetchFullManifests(selectedNames, summaries);
      console.log('[OBJECT-CREATOR] Fetched manifests for:', deps.map((d) => d.name));

      const depContext = this.formatFullManifestContext(deps);

      // Phase 1: Generate manifest
      const phase1 = await this.generateManifest(prompt, depContext, context);
      if (!phase1.manifest) {
        return { success: false, error: 'Phase 1: Failed to generate valid manifest' };
      }

      // Phase 2: Generate handler code
      let code = await this.generateHandlerCode(
        phase1.manifest, prompt, depContext, phase1.usedObjects, context
      );
      if (!code) {
        return { success: false, error: 'Phase 2: Failed to generate handler code' };
      }

      // Phase 3: Verify manifest/code consistency
      const verified = this.verifyAndFix(phase1.manifest, code);
      let manifest = verified.manifest;
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

      // Phase 4: Compile check
      const compileError = ScriptableAbject.tryCompile(code);
      if (compileError) {
        const fixResult = await this.llmComplete([
          systemMessage(
            'The following JavaScript handler map failed to compile with `new Function()`. ' +
            'Fix it so it is valid plain JavaScript. No TypeScript annotations, no type casts, no interfaces. ' +
            'Output ONLY the corrected handler map in a ```javascript code block. Nothing else.'
          ),
          userMessage(`Handler map:\n\`\`\`javascript\n${code}\n\`\`\`\n\nError: ${compileError}`),
        ]);
        const fixMatch = fixResult.content.match(/```(?:javascript|js)\s*([\s\S]*?)\s*```/);
        if (fixMatch) {
          const retryError = ScriptableAbject.tryCompile(fixMatch[1]);
          if (!retryError) {
            code = fixMatch[1];
          } else {
            return { success: false, error: `Compilation failed after retry: ${retryError}`, code };
          }
        } else {
          return { success: false, error: `Compilation failed: ${compileError}`, code };
        }
      }

      // Phase 5: Spawn via Factory with deps
      if (this.factoryId) {
        // Build deps map: name → AbjectId
        const depsMap: Record<string, AbjectId> = {};
        for (const dep of deps) {
          depsMap[dep.name] = dep.id;
        }

        const spawnResult = await this.factorySpawn({
          manifest,
          source: code,
          owner: this.id,
          deps: depsMap,
        });

        // Phase 6: Connect to dependencies via Negotiator (fire-and-forget)
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
      const depContext = this.formatFullManifestContext(deps);

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

      const result = await this.llmComplete(messages);
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
    ]);

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

    const result = await this.llmComplete(messages);
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

    const result = await this.llmComplete(messages);
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

    const result = await this.llmComplete(messages);
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

### UI Objects (objects that display a window)
If the new object needs a visible window, its manifest MUST include these methods:
- show: creates and displays the window with widgets
- hide: destroys/closes the window
- widgetEvent: receives UI interaction events (clicks, text input) from widgets

The system Taskbar automatically discovers objects with show + hide and adds launch buttons for them. Without these methods, the user has no way to open the object.

### Non-UI Objects
Objects that only perform background work (data processing, scheduling, etc.) do NOT need show/hide/widgetEvent.`;
  }

  /**
   * Phase 2 system prompt: generate handler code using this.call() pattern.
   */
  private getPhase2SystemPrompt(): string {
    return `You are an Abjects code generator. Given a manifest and dependency information, you generate the handler map (plain JavaScript) for a ScriptableAbject.

Output ONLY the handler map in a \`\`\`javascript code block. Nothing else.

CRITICAL RULES:
- You MUST implement a handler for EVERY method listed in the manifest. No exceptions.
- You MUST NOT add public methods that are not in the manifest. Private properties prefixed with _ are OK.
- The handler map is a FLAT parenthesized object expression: ({ method(msg) { ... } })
- Each handler receives a SINGLE argument: a message object (msg) with msg.payload containing parameters.
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

## Concrete Example: UI Object Handler Map

This is a complete, minimal, working UI object. Study it carefully — it shows every critical pattern:

\`\`\`javascript
({
  _windowId: null,

  async show(msg) {
    if (this._windowId) return true;
    this._windowId = await this.call(this.dep('WidgetManager'), 'abjects:widgets', 'createWindow', {
      title: 'My Object',
      rect: { x: 100, y: 100, width: 300, height: 200 },
    });
    await this.call(this.dep('WidgetManager'), 'abjects:widgets', 'addWidget', {
      windowId: this._windowId, id: 'title', type: 'label',
      rect: { x: 16, y: 8, width: 260, height: 28 },
      text: 'Hello!',
      style: { fontSize: 20, fontWeight: 'bold', color: '#fff' },
    });
    await this.call(this.dep('WidgetManager'), 'abjects:widgets', 'addWidget', {
      windowId: this._windowId, id: 'my-button', type: 'button',
      rect: { x: 16, y: 50, width: 120, height: 32 },
      text: 'Click Me',
    });
    return true;
  },

  async hide(msg) {
    if (!this._windowId) return true;
    await this.call(this.dep('WidgetManager'), 'abjects:widgets', 'destroyWindow', {
      windowId: this._windowId,
    });
    this._windowId = null;
    return true;
  },

  async widgetEvent(msg) {
    const { widgetId, type, value } = msg.payload;
    if (widgetId === 'my-button' && type === 'click') {
      // handle click
    }
  }
})
\`\`\`

## Widget Types Reference

WidgetManager supports 8 widget types via addWidget (type field):
- **label**: Static text. Key props: text, style (color, fontSize, fontWeight, align, background)
- **button**: Clickable button. Emits widgetEvent with type='click'. Key props: text, style
- **textInput**: Single-line text field. Emits 'change' on typing, 'submit' on Enter. Key props: text, placeholder, style
- **checkbox**: Toggle checkbox. Emits 'change' with value 'true'/'false'. Key props: text (label), checked
- **progress**: Read-only progress bar. Key props: value (0-1), text (optional overlay), style (color=fill, background=track)
- **divider**: Horizontal or vertical line separator. Orientation determined by rect aspect ratio. Key props: style (color)
- **select**: Dropdown select. Emits 'change' with selected option text. Key props: options (string[]), selectedIndex
- **textArea**: Multi-line text editor. Emits 'change' on typing. Key props: text, monospace, placeholder, style

## Calling Other Dependencies

Each dependency description lists its interfaces and methods. Translate them into this.call() invocations:

If a dependency named "SomeService" has:
  Interface: abjects:some-service
  Methods: doThing(x: string) -> { result: string }
  Events: thingHappened — Payload: { data: string }

Then:
\`\`\`javascript
// Calling a method:
const result = await this.call(this.dep('SomeService'), 'abjects:some-service', 'doThing', { x: 'hello' });

// Handling an event (add a handler in your handler map):
async thingHappened(msg) {
  const { data } = msg.payload;
  // handle the event
}
\`\`\`

## Timer Events

If your object uses a Timer dependency, handle timer events like this:
\`\`\`javascript
async timerFired(msg) {
  const { timerId, data } = msg.payload;
  // update state, refresh UI, etc.
}
\`\`\`

## IMPORTANT
- The ONLY methods available on \`this\` are: call(), dep(), find(), and this.id
- Study the dependency descriptions to learn their interface IDs, method names, and event names
- Do NOT invent wrapper APIs — no api.*, no Host.*, no this.services.*, no this.ui.*, no window.*, no document.*
- The ONLY way to call another object is: this.call(this.dep('Name'), interfaceId, method, payload)
- There are NO shortcuts, wrappers, or helper objects. Always use this.call() directly.`;
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
ALL interaction with dependencies MUST go through this.call(this.dep('Name'), interfaceId, method, payload).`;
  }
}

// Well-known object creator ID
export const OBJECT_CREATOR_ID = 'abjects:object-creator' as AbjectId;
