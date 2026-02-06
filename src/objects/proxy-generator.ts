/**
 * Proxy Generator - creates LLM-generated proxy ScriptableAbjects for protocol translation.
 *
 * Generates JavaScript handler maps (not TypeScript classes) that can be spawned
 * as ScriptableAbjects via the Factory.
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  InterfaceId,
  ProtocolAgreement,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require } from '../core/contracts.js';
import { request } from '../core/message.js';
import { INTROSPECT_INTERFACE_ID, IntrospectResult } from '../core/introspect.js';
import { ScriptableAbject } from './scriptable-abject.js';
import { systemMessage, userMessage, LLMMessage, LLMCompletionResult } from '../llm/provider.js';

const PROXY_GENERATOR_INTERFACE = 'abjects:proxy-generator';

export interface ProxyGenerationRequest {
  sourceId: AbjectId;
  targetId: AbjectId;
  sourceDescription?: string;
  targetDescription?: string;
}

export interface GeneratedProxy {
  proxyCode: string;
  handlerSource: string;
  proxyManifest: AbjectManifest;
  agreement: ProtocolAgreement;
}

/**
 * Generates proxy ScriptableAbjects that translate between incompatible interfaces.
 */
export class ProxyGenerator extends Abject {
  private llmId?: AbjectId;
  private generatedProxies: Map<string, GeneratedProxy> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'ProxyGenerator',
        description:
          'Generates proxy objects using LLM to translate between incompatible object interfaces.',
        version: '1.0.0',
        interfaces: [
          {
            id: PROXY_GENERATOR_INTERFACE,
            name: 'ProxyGenerator',
            description: 'Proxy generation',
            methods: [
              {
                name: 'generateProxy',
                description: 'Generate a proxy between two objects',
                parameters: [
                  {
                    name: 'sourceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Source object ID',
                  },
                  {
                    name: 'targetId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Target object ID',
                  },
                  {
                    name: 'sourceDescription',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Source object description (from introspect)',
                    optional: true,
                  },
                  {
                    name: 'targetDescription',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Target object description (from introspect)',
                    optional: true,
                  },
                ],
                returns: { kind: 'reference', reference: 'GeneratedProxy' },
              },
              {
                name: 'regenerateProxy',
                description: 'Regenerate a proxy due to errors',
                parameters: [
                  {
                    name: 'agreementId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'The agreement to regenerate',
                  },
                  {
                    name: 'errorContext',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Context about what went wrong',
                  },
                ],
                returns: { kind: 'reference', reference: 'GeneratedProxy' },
              },
            ],
          },
        ],
        requiredCapabilities: [],
        tags: ['system', 'proxy', 'llm'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('generateProxy', async (msg: AbjectMessage) => {
      const { sourceId, targetId, sourceDescription, targetDescription } =
        msg.payload as ProxyGenerationRequest;
      return this.generateProxy(sourceId, targetId, sourceDescription, targetDescription);
    });

    this.on('regenerateProxy', async (msg: AbjectMessage) => {
      const { agreementId, errorContext } = msg.payload as {
        agreementId: string;
        errorContext: string;
      };
      return this.regenerateProxy(agreementId, errorContext);
    });
  }

  /**
   * Set the LLM object ID for code generation via message passing.
   */
  setLLMId(id: AbjectId): void {
    this.llmId = id;
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
   * Ask an object to describe itself via introspect protocol.
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
   * Generate a proxy between two objects.
   */
  async generateProxy(
    sourceId: AbjectId,
    targetId: AbjectId,
    sourceDescription?: string,
    targetDescription?: string
  ): Promise<GeneratedProxy> {
    require(this.llmId !== undefined, 'LLM object not set');

    // If descriptions not provided, introspect the objects directly
    if (!sourceDescription) {
      const result = await this.introspect(sourceId);
      sourceDescription = result?.description ?? `Object ${sourceId}`;
    }
    if (!targetDescription) {
      const result = await this.introspect(targetId);
      targetDescription = result?.description ?? `Object ${targetId}`;
    }

    // Generate handler map via LLM
    const handlerSource = await this.generateHandlerMap(
      sourceId, targetId, sourceDescription, targetDescription
    );

    // Create proxy manifest
    const proxyManifest = this.createProxyManifest(sourceDescription, targetDescription);

    // Create protocol agreement
    const agreement = this.createAgreement(sourceId, targetId);

    const generated: GeneratedProxy = {
      proxyCode: handlerSource,
      handlerSource,
      proxyManifest,
      agreement,
    };

    // Cache for regeneration
    this.generatedProxies.set(agreement.agreementId, generated);

    return generated;
  }

  /**
   * Regenerate a proxy with additional error context.
   */
  async regenerateProxy(
    agreementId: string,
    errorContext: string
  ): Promise<GeneratedProxy> {
    require(this.llmId !== undefined, 'LLM object not set');

    const existing = this.generatedProxies.get(agreementId);
    require(existing !== undefined, 'Agreement not found');

    const result = await this.llmComplete([
      systemMessage(this.getProxySystemPrompt()),
      userMessage(`The previous proxy implementation had issues:
${errorContext}

Previous handler map:
\`\`\`javascript
${existing!.handlerSource}
\`\`\`

Generate a corrected handler map that fixes these issues. Output ONLY the handler map in a \`\`\`javascript code block.`),
    ]);

    let handlerSource = this.parseCodeResponse(result.content) ?? existing!.handlerSource;

    // Validate compilation
    const compileError = ScriptableAbject.tryCompile(handlerSource);
    if (compileError) {
      console.warn('[PROXY-GEN] Regenerated code failed to compile:', compileError);
      handlerSource = existing!.handlerSource;
    }

    const regenerated: GeneratedProxy = {
      proxyCode: handlerSource,
      handlerSource,
      proxyManifest: existing!.proxyManifest,
      agreement: {
        ...existing!.agreement,
        createdAt: Date.now(),
      },
    };

    this.generatedProxies.set(agreementId, regenerated);

    return regenerated;
  }

  /**
   * Generate a handler map for the proxy via LLM.
   */
  private async generateHandlerMap(
    sourceId: AbjectId,
    targetId: AbjectId,
    sourceDescription: string,
    targetDescription: string
  ): Promise<string> {
    const result = await this.llmComplete([
      systemMessage(this.getProxySystemPrompt()),
      userMessage(`Generate a JavaScript handler map for a proxy that translates messages between two objects.

SOURCE OBJECT:
${sourceDescription}

TARGET OBJECT:
${targetDescription}

The proxy receives messages from the source, translates them, and forwards to the target.
Use this.call(this.dep('target'), interfaceId, method, payload) to forward.
Use this.dep('source') and this.dep('target') for object IDs.

Output ONLY the handler map in a \`\`\`javascript code block.`),
    ]);

    let handlerSource = this.parseCodeResponse(result.content);

    if (!handlerSource) {
      // Fallback: generate a simple pass-through proxy
      handlerSource = this.getFallbackHandlerMap();
    }

    // Validate compilation
    const compileError = ScriptableAbject.tryCompile(handlerSource);
    if (compileError) {
      console.warn('[PROXY-GEN] Generated code failed to compile, using fallback:', compileError);
      handlerSource = this.getFallbackHandlerMap();
    }

    return handlerSource;
  }

  /**
   * System prompt for proxy handler map generation.
   */
  private getProxySystemPrompt(): string {
    return `You generate JavaScript handler maps for proxy ScriptableAbjects that translate messages between two objects.

The handler map is a parenthesized object expression:
({
  async methodName(msg) {
    // translate and forward
    const result = await this.call(this.dep('target'), 'interface:id', 'method', payload);
    return result;
  }
})

RULES:
- MUST be plain JavaScript (NOT TypeScript). No type annotations.
- Format: parenthesized object expression ({ ... })
- Each handler receives msg with msg.payload containing parameters
- Use this.call(this.dep('target'), interfaceId, method, payload) to forward to target
- Use this.dep('source') and this.dep('target') for object IDs
- Include a wildcard handler '*' as catch-all for unmatched methods
- Handle errors gracefully with try/catch
- Return values from handlers to auto-reply`;
  }

  /**
   * Fallback handler map for when LLM generation fails.
   */
  private getFallbackHandlerMap(): string {
    return `({
  async ['*'](msg) {
    try {
      const method = msg.routing.method;
      const iface = msg.routing.interface;
      return await this.call(this.dep('target'), iface, method, msg.payload);
    } catch (err) {
      return { error: err.message || String(err) };
    }
  }
})`;
  }

  /**
   * Parse code from LLM response.
   */
  private parseCodeResponse(content: string): string | undefined {
    let match = content.match(/```(?:javascript|js)\s*([\s\S]*?)\s*```/);
    if (!match) {
      match = content.match(/```\s*([\s\S]*?)\s*```/);
    }
    return match?.[1];
  }

  /**
   * Create a manifest for the generated proxy.
   */
  private createProxyManifest(
    sourceDescription: string,
    targetDescription: string
  ): AbjectManifest {
    // Extract names from descriptions (first line before " — " or "(")
    const sourceName = sourceDescription.split(/\s*[—(]/)[0].trim();
    const targetName = targetDescription.split(/\s*[—(]/)[0].trim();

    return {
      name: `Proxy_${sourceName}_${targetName}`,
      description: `LLM-generated proxy that translates between ${sourceName} and ${targetName}`,
      version: '1.0.0',
      interfaces: [
        {
          id: `proxy:${sourceName.toLowerCase()}-${targetName.toLowerCase()}` as InterfaceId,
          name: `Proxy`,
          description: `Translates between ${sourceName} and ${targetName}`,
          methods: [
            {
              name: '*',
              description: 'Wildcard handler that translates and forwards all messages',
              parameters: [],
            },
          ],
        },
      ],
      requiredCapabilities: [],
      tags: ['proxy', 'generated'],
    };
  }

  /**
   * Create a protocol agreement.
   */
  private createAgreement(
    sourceId: AbjectId,
    targetId: AbjectId
  ): ProtocolAgreement {
    const agreementId = `agreement-${sourceId}-${targetId}-${Date.now()}`;

    return {
      agreementId,
      participants: [sourceId, targetId],
      protocol: {
        version: '1.0.0',
        bindings: {},
      },
      healthCheckInterval: 30000,
      createdAt: Date.now(),
    };
  }

  /**
   * Get a cached proxy.
   */
  getProxy(agreementId: string): GeneratedProxy | undefined {
    return this.generatedProxies.get(agreementId);
  }

  /**
   * Clear cached proxies.
   */
  clearCache(): void {
    this.generatedProxies.clear();
  }
}

// Well-known proxy generator ID
export const PROXY_GENERATOR_ID = 'abjects:proxy-generator' as AbjectId;
