/**
 * Object Creator - user-facing object for creating and modifying objects via natural language.
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

/**
 * The Object Creator allows users to create objects via natural language prompts.
 */
export class ObjectCreator extends Abject {
  private llmId?: AbjectId;
  private registryId?: AbjectId;
  private factoryId?: AbjectId;

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
  setDependencies(llmId: AbjectId, registryId: AbjectId, factoryId: AbjectId): void {
    this.llmId = llmId;
    this.registryId = registryId;
    this.factoryId = factoryId;
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

  /**
   * Create a new object from a natural language prompt.
   * Uses 3 phases: manifest generation, code generation, verification.
   */
  async createObject(prompt: string, context?: string): Promise<CreationResult> {
    require(this.llmId !== undefined, 'LLM not set');
    require(this.registryId !== undefined, 'Registry not set');

    try {
      // Discover available objects
      const availableObjects = await this.discoverRelevantObjects(prompt);

      // Phase 1: Generate manifest only
      const phase1 = await this.generateManifest(prompt, availableObjects, context);
      if (!phase1.manifest) {
        return { success: false, error: 'Phase 1: Failed to generate valid manifest' };
      }

      // Phase 2: Generate handler code given the manifest
      let code = await this.generateHandlerCode(
        phase1.manifest, prompt, availableObjects, phase1.usedObjects, context
      );
      if (!code) {
        return { success: false, error: 'Phase 2: Failed to generate handler code' };
      }

      // Phase 3: Verify manifest/code consistency and fix mismatches
      const verified = this.verifyAndFix(phase1.manifest, code);
      let manifest = verified.manifest;
      code = verified.code;

      // If verification found unfixable issues, try LLM-assisted fix
      if (verified.mismatches.length > 0) {
        try {
          const llmFixed = await this.llmVerifyAndFix(manifest, code, verified.mismatches);
          manifest = llmFixed.manifest;
          code = llmFixed.code;
        } catch (err) {
          console.warn('[OBJECT-CREATOR] LLM verify/fix failed, continuing with unverified code:', err);
        }
      }

      // Validate the code compiles before spawning
      const compileError = ScriptableAbject.tryCompile(code);
      if (compileError) {
        // Ask LLM to fix the code — one retry
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

      // Spawn the ScriptableAbject via Factory
      if (this.factoryId) {
        const spawnResult = await this.factorySpawn({
          manifest,
          source: code,
          owner: this.id,
        });
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
      const sourceBlock = currentSource
        ? `\nCurrent handler source:\n\`\`\`javascript\n${currentSource}\n\`\`\`\n`
        : '';

      const messages: LLMMessage[] = [
        systemMessage(this.getModificationSystemPrompt()),
        userMessage(`Current manifest:
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

  /**
   * Discover objects relevant to a prompt.
   */
  private async discoverRelevantObjects(prompt: string): Promise<ObjectRegistration[]> {
    if (!this.registryId || !this.llmId) {
      return [];
    }

    const allObjects = await this.registryList();

    // Use LLM to filter relevant objects
    const objectDescriptions = allObjects
      .map((o) => `${o.manifest.name}: ${o.manifest.description}`)
      .join('\n');

    const result = await this.llmComplete([
      systemMessage(
        'You identify which objects would be useful for a given task. Return only the names of relevant objects, one per line.'
      ),
      userMessage(`Available objects:
${objectDescriptions}

Task: ${prompt}

Which objects would be useful? Return only names.`),
    ]);

    const relevantNames = new Set(
      result.content
        .split('\n')
        .map((n) => n.trim().toLowerCase())
    );

    return allObjects.filter((o) =>
      relevantNames.has(o.manifest.name.toLowerCase())
    );
  }

  /**
   * Format available objects as context text for prompts.
   */
  private formatObjectContext(availableObjects: ObjectRegistration[]): string {
    if (availableObjects.length === 0) return 'None';
    return availableObjects
      .map((o) => {
        const interfaces = o.manifest.interfaces
          .map((i) => {
            const methods = i.methods
              .map((m) => `    ${m.name}(${m.parameters.map((p) => p.name).join(', ')})`)
              .join('\n');
            return `  Interface ${i.id}:\n${methods}`;
          })
          .join('\n');
        return `Object: ${o.manifest.name} (${o.id})\n${o.manifest.description}\n${interfaces}`;
      })
      .join('\n\n');
  }

  /**
   * Phase 1: Generate only the manifest JSON from user prompt.
   */
  private async generateManifest(
    prompt: string,
    availableObjects: ObjectRegistration[],
    context?: string
  ): Promise<{ manifest?: AbjectManifest; usedObjects: string[] }> {
    const objectContext = this.formatObjectContext(availableObjects);
    const messages: LLMMessage[] = [
      systemMessage(this.getPhase1SystemPrompt()),
      userMessage(`Available objects for composition:\n${objectContext}\n\n${context ? `Additional context: ${context}\n\n` : ''}User request: ${prompt}\n\nDesign the manifest for this object.`),
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
    availableObjects: ObjectRegistration[],
    usedObjects: string[],
    context?: string
  ): Promise<string | undefined> {
    const methodList = manifest.interfaces
      .flatMap((i) => i.methods.map((m) => m.name));
    const objectContext = this.formatObjectContext(availableObjects);

    const messages: LLMMessage[] = [
      systemMessage(this.getPhase2SystemPrompt()),
      userMessage(`Manifest:\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`\n\nYou MUST implement handlers for these methods: ${methodList.join(', ')}\n\nAvailable objects for composition:\n${objectContext}\n\nUsed objects: ${usedObjects.length > 0 ? usedObjects.join(', ') : 'None'}\n\n${context ? `Additional context: ${context}\n\n` : ''}Original user request: ${prompt}\n\nGenerate the handler map.`),
    ];

    const result = await this.llmComplete(messages);
    return this.parseCodeResponse(result.content);
  }

  /**
   * Phase 3: Programmatic verification of manifest/code consistency.
   * Returns mismatches if any; does NOT call LLM.
   */
  private verifyAndFix(
    manifest: AbjectManifest,
    code: string
  ): { manifest: AbjectManifest; code: string; mismatches: string[] } {
    const mismatches: string[] = [];

    // Extract declared method names from manifest
    const declaredMethods = new Set(
      manifest.interfaces.flatMap((i) => i.methods.map((m) => m.name))
    );

    // Try to extract handler names from compiled code
    let handlerNames: string[] = [];
    try {
      const handlerMap = new Function('return ' + code)();
      if (typeof handlerMap === 'object' && handlerMap !== null) {
        handlerNames = Object.keys(handlerMap).filter((k) => !k.startsWith('_'));
      }
    } catch {
      // If code doesn't compile, skip verification — compile step will catch it
      return { manifest, code, mismatches: [] };
    }

    const implementedMethods = new Set(handlerNames);

    // Find missing handlers (in manifest but not in code)
    for (const method of declaredMethods) {
      if (!implementedMethods.has(method)) {
        mismatches.push(`Missing handler: '${method}' declared in manifest but not implemented`);
      }
    }

    // Find extra handlers (in code but not in manifest)
    for (const handler of implementedMethods) {
      if (!declaredMethods.has(handler)) {
        mismatches.push(`Extra handler: '${handler}' implemented but not declared in manifest`);
      }
    }

    return { manifest, code, mismatches };
  }

  /**
   * Phase 3 LLM fallback: Ask LLM to fix manifest/code mismatches.
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

    // Try to extract corrected manifest and/or code
    const manifestParsed = this.parseManifestResponse(content);
    const codeParsed = this.parseCodeResponse(content);

    return {
      manifest: manifestParsed.manifest ?? manifest,
      code: codeParsed ?? code,
    };
  }

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
   * Used by modifyObject().
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

  /**
   * Phase 1 system prompt: generate manifest only.
   */
  private getPhase1SystemPrompt(): string {
    return `You are an Abjects manifest designer. You design manifests for ScriptableAbjects in a distributed message-passing system.

Output ONLY a manifest JSON in a \`\`\`json code block, followed by a "Used objects:" line listing which available objects the implementation will need.

CRITICAL RULES:
- Only declare methods that WILL actually be implemented in the handler code.
- If the object has a UI (window, display, visual output), you MUST include these methods: show, hide, widgetEvent.
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

Used objects: None`;
  }

  /**
   * Phase 2 system prompt: generate handler code only.
   */
  private getPhase2SystemPrompt(): string {
    return `You are an Abjects code generator. Given a manifest, you generate the handler map (plain JavaScript) for a ScriptableAbject.

Output ONLY the handler map in a \`\`\`javascript code block. Nothing else.

CRITICAL RULES:
- You MUST implement a handler for EVERY method listed in the manifest. No exceptions.
- You MUST NOT add public methods that are not in the manifest. Private properties prefixed with _ are OK.
- The handler map is a parenthesized object expression: ({ method(msg) { ... } })
- Each handler receives a message object (msg) with msg.payload containing parameters.
- Return a value from a handler to auto-reply.
- MUST be plain JavaScript (NOT TypeScript). No type annotations, no "as" casts, no interfaces. It will be compiled with new Function() at runtime.

## UI Capabilities

Handler functions are bound to the object instance. These are the ONLY available methods on \`this\`:

- this.createWindow(title, {x,y,width,height}, {resizable?}) → windowId
- this.addWidget(windowId, widgetId, type, {x,y,width,height}, {text?, placeholder?})
  Types: 'label', 'textInput', 'button', 'textArea'
- this.updateWidget(widgetId, text)
- this.getWidgetValue(widgetId) → string
- this.destroyWindow(windowId)
- this.getDisplayInfo() → {width, height}
- this.call(objectId, interfaceId, method, payload) → result
- this.id — this object's ID

NEVER use this.services, this.api, this.ctx, or any other property not listed above. Call UI methods directly on this (e.g. this.createWindow, NOT this.services.window).

### Show/Hide Pattern
Objects with a UI MUST implement show and hide methods. They get a taskbar button automatically.

Example:
\`\`\`javascript
({
  _windowId: null,
  async show(msg) {
    if (this._windowId) return true;
    const display = await this.getDisplayInfo();
    this._windowId = await this.createWindow('My App', {
      x: Math.floor((display.width - 300) / 2),
      y: Math.floor((display.height - 200) / 2),
      width: 300, height: 200
    }, { resizable: true });
    await this.addWidget(this._windowId, 'lbl', 'label',
      { x: 16, y: 10, width: 268, height: 20 }, { text: 'Hello!' });
    return true;
  },
  async hide(msg) {
    if (!this._windowId) return true;
    await this.destroyWindow(this._windowId);
    this._windowId = null;
    return true;
  },
  async widgetEvent(msg) {
    const { widgetId, type } = msg.payload;
    // Handle button clicks etc.
  }
})
\`\`\``;
  }

  /**
   * Phase 3 system prompt: verify and fix manifest/code consistency.
   */
  private getPhase3SystemPrompt(): string {
    return `You are an Abjects consistency checker. You verify that a manifest and handler code match exactly.

Rules:
- Every method declared in the manifest MUST have a corresponding handler in the code.
- Every public handler (not prefixed with _) in the code MUST be declared in the manifest.
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

The ONLY methods available on \`this\` are: this.createWindow(), this.addWidget(), this.updateWidget(),
this.getWidgetValue(), this.destroyWindow(), this.getDisplayInfo(), this.call(), this.id
NEVER use this.services, this.api, this.ctx, or any other property not listed above.
Objects with show/hide methods get taskbar buttons automatically.`;
  }
}

// Well-known object creator ID
export const OBJECT_CREATOR_ID = 'abjects:object-creator' as AbjectId;
