/**
 * Object Creator - user-facing object for creating and modifying objects via natural language.
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  ObjectRegistration,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require } from '../core/contracts.js';

import { LLMObject } from './llm-object.js';
import { Registry } from './registry.js';
import { Factory } from './factory.js';
import { systemMessage, userMessage, LLMMessage } from '../llm/provider.js';


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
  private llm?: LLMObject;
  private registry?: Registry;
  private _factory?: Factory;

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
   * Set dependencies.
   */
  setDependencies(llm: LLMObject, registry: Registry, factory: Factory): void {
    this.llm = llm;
    this.registry = registry;
    this._factory = factory;
  }

  /**
   * Create a new object from a natural language prompt.
   */
  async createObject(prompt: string, context?: string): Promise<CreationResult> {
    require(this.llm !== undefined, 'LLM not set');
    require(this.registry !== undefined, 'Registry not set');

    try {
      // Discover available objects
      const availableObjects = await this.discoverRelevantObjects(prompt);

      // Build creation prompt
      const messages = this.buildCreationPrompt(prompt, availableObjects, context);

      // Generate object code
      const result = await this.llm!.complete(messages);

      // Parse the response
      const parsed = this.parseCreationResponse(result.content);

      if (!parsed.manifest || !parsed.code) {
        return {
          success: false,
          error: 'Failed to generate valid object',
        };
      }

      // TODO: Compile and spawn the object
      // For now, return the generated code

      return {
        success: true,
        manifest: parsed.manifest,
        code: parsed.code,
        usedObjects: parsed.usedObjects,
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
    require(this.llm !== undefined, 'LLM not set');
    require(this.registry !== undefined, 'Registry not set');

    const registration = this.registry!.lookupObject(objectId);
    if (!registration) {
      return { success: false, error: 'Object not found' };
    }

    try {
      const messages: LLMMessage[] = [
        systemMessage(this.getModificationSystemPrompt()),
        userMessage(`Current manifest:
\`\`\`json
${JSON.stringify(registration.manifest, null, 2)}
\`\`\`

Modification request: ${prompt}

Generate the updated object code that implements this change.`),
      ];

      const result = await this.llm!.complete(messages);
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
    require(this.llm !== undefined, 'LLM not set');

    const available = await this.listAvailableObjects();
    const availableList = available.map((o) => `- ${o.manifest.name}: ${o.manifest.description}`).join('\n');

    const result = await this.llm!.complete([
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
    if (!this.registry) {
      return [];
    }
    return this.registry.listObjects();
  }

  /**
   * Get the object dependency graph.
   */
  async getObjectGraph(): Promise<{
    nodes: Array<{ id: string; name: string }>;
    edges: Array<{ from: string; to: string }>;
  }> {
    if (!this.registry) {
      return { nodes: [], edges: [] };
    }

    const objects = this.registry.listObjects();
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
    if (!this.registry || !this.llm) {
      return [];
    }

    const allObjects = this.registry.listObjects();

    // Use LLM to filter relevant objects
    const objectDescriptions = allObjects
      .map((o) => `${o.manifest.name}: ${o.manifest.description}`)
      .join('\n');

    const result = await this.llm.complete([
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
   * Build the prompt for object creation.
   */
  private buildCreationPrompt(
    prompt: string,
    availableObjects: ObjectRegistration[],
    context?: string
  ): LLMMessage[] {
    const objectContext = availableObjects
      .map((o) => {
        const interfaces = o.manifest.interfaces
          .map((i) => {
            const methods = i.methods
              .map((m) => `    ${m.name}(${m.parameters.map((p) => p.name).join(', ')})`)
              .join('\n');
            return `  Interface ${i.id}:\n${methods}`;
          })
          .join('\n');
        return `Object: ${o.manifest.name} (${o.id})
${o.manifest.description}
${interfaces}`;
      })
      .join('\n\n');

    return [
      systemMessage(this.getCreationSystemPrompt()),
      userMessage(`Available objects for composition:
${objectContext || 'None'}

${context ? `Additional context: ${context}\n\n` : ''}User request: ${prompt}

Generate a new Abjects object that fulfills this request. Use the available objects where appropriate.`),
    ];
  }

  /**
   * Parse the LLM response for object creation.
   */
  private parseCreationResponse(content: string): {
    manifest?: AbjectManifest;
    code?: string;
    usedObjects?: string[];
  } {
    // Extract JSON manifest
    const manifestMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
    let manifest: AbjectManifest | undefined;

    if (manifestMatch) {
      try {
        manifest = JSON.parse(manifestMatch[1]);
      } catch {
        // Try to extract from other formats
      }
    }

    // Extract code
    const codeMatch = content.match(/```(?:typescript|ts)\s*([\s\S]*?)\s*```/);
    const code = codeMatch?.[1];

    // Extract used objects
    const usedMatch = content.match(/Used objects?:\s*([\s\S]*?)(?:\n\n|$)/i);
    const usedObjects = usedMatch?.[1]
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    return { manifest, code, usedObjects };
  }

  /**
   * Get the system prompt for object creation.
   */
  private getCreationSystemPrompt(): string {
    return `You are an Abjects object creator. You generate TypeScript code for objects in a distributed message-passing system.

Objects must:
1. Extend the Abject base class
2. Define a manifest with name, description, version, interfaces, and requiredCapabilities
3. Implement message handlers using this.on('methodName', handler)
4. Use this.send() to send messages to other objects
5. Use this.request() to send and await replies

Output format:
1. First, output the manifest as JSON in a \`\`\`json code block
2. Then, output the TypeScript code in a \`\`\`typescript code block
3. Finally, list which available objects you used (if any)

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

Generate clean, well-documented code that follows best practices.`;
  }

  /**
   * Get the system prompt for object modification.
   */
  private getModificationSystemPrompt(): string {
    return `You are an Abjects object modifier. You update existing object code while preserving its core functionality.

When modifying objects:
1. Preserve the object's ID and registration
2. Update the manifest if interfaces change
3. Maintain backward compatibility where possible
4. Document breaking changes

Output the updated manifest and code in the same format as object creation.`;
  }
}

// Well-known object creator ID
export const OBJECT_CREATOR_ID = 'abjects:object-creator' as AbjectId;
