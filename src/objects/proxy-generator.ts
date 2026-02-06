/**
 * Proxy Generator - creates LLM-generated proxy objects for protocol translation.
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  InterfaceId,
  InterfaceDeclaration,
  ProtocolAgreement,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require } from '../core/contracts.js';
import { request } from '../core/message.js';

const PROXY_GENERATOR_INTERFACE = 'abjects:proxy-generator';

export interface ProxyGenerationRequest {
  sourceId: AbjectId;
  targetId: AbjectId;
  sourceManifest: AbjectManifest;
  targetManifest: AbjectManifest;
}

export interface GeneratedProxy {
  proxyCode: string;
  proxyManifest: AbjectManifest;
  agreement: ProtocolAgreement;
}

/**
 * Generates proxy objects that translate between incompatible interfaces.
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
                    name: 'sourceManifest',
                    type: { kind: 'reference', reference: 'AbjectManifest' },
                    description: 'Source object manifest',
                  },
                  {
                    name: 'targetManifest',
                    type: { kind: 'reference', reference: 'AbjectManifest' },
                    description: 'Target object manifest',
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
      const { sourceId, targetId, sourceManifest, targetManifest } =
        msg.payload as ProxyGenerationRequest;
      return this.generateProxy(sourceId, targetId, sourceManifest, targetManifest);
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
   * Generate code via LLM message passing.
   */
  private async llmGenerateCode(language: string, description: string, context?: string): Promise<string> {
    return this.request<string>(
      request(this.id, this.llmId!, 'abjects:llm' as InterfaceId, 'generateCode', { language, description, context })
    );
  }

  /**
   * Generate a proxy between two objects.
   */
  async generateProxy(
    sourceId: AbjectId,
    targetId: AbjectId,
    sourceManifest: AbjectManifest,
    targetManifest: AbjectManifest
  ): Promise<GeneratedProxy> {
    require(this.llmId !== undefined, 'LLM object not set');

    // Build the prompt for the LLM
    const prompt = this.buildProxyPrompt(
      sourceManifest,
      targetManifest,
      sourceId,
      targetId
    );

    // Generate proxy code
    const proxyCode = await this.llmGenerateCode(
      'typescript',
      prompt,
      this.getProxyTemplate()
    );

    // Create proxy manifest
    const proxyManifest = this.createProxyManifest(
      sourceManifest,
      targetManifest
    );

    // Create protocol agreement
    const agreement = this.createAgreement(sourceId, targetId);

    const generated: GeneratedProxy = {
      proxyCode,
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

    // Build regeneration prompt
    const prompt = `The previous proxy implementation had issues:
${errorContext}

Please fix the proxy code. The previous implementation was:
\`\`\`typescript
${existing!.proxyCode}
\`\`\`

Generate a corrected version that handles these issues.`;

    const proxyCode = await this.llmGenerateCode(
      'typescript',
      prompt,
      this.getProxyTemplate()
    );

    const regenerated: GeneratedProxy = {
      proxyCode,
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
   * Build the prompt for proxy generation.
   */
  private buildProxyPrompt(
    sourceManifest: AbjectManifest,
    targetManifest: AbjectManifest,
    sourceId: AbjectId,
    targetId: AbjectId
  ): string {
    const sourceInterfaces = this.formatInterfaces(sourceManifest.interfaces);
    const targetInterfaces = this.formatInterfaces(targetManifest.interfaces);

    return `Generate a proxy object that translates messages between two objects.

SOURCE OBJECT (${sourceManifest.name}):
${sourceManifest.description}
Interfaces:
${sourceInterfaces}

TARGET OBJECT (${targetManifest.name}):
${targetManifest.description}
Interfaces:
${targetInterfaces}

The proxy must:
1. Receive messages from the source object
2. Transform the message format to match the target's interface
3. Forward to the target
4. Transform responses back to the source's expected format
5. Handle errors gracefully

Source ID: ${sourceId}
Target ID: ${targetId}

Generate a TypeScript class that extends the Abject base class and handles this translation.`;
  }

  /**
   * Format interfaces for the prompt.
   */
  private formatInterfaces(interfaces: InterfaceDeclaration[]): string {
    return interfaces
      .map((iface) => {
        const methods = iface.methods
          .map((m) => {
            const params = m.parameters
              .map((p) => `${p.name}: ${this.formatType(p.type)}`)
              .join(', ');
            const returns = m.returns ? `: ${this.formatType(m.returns)}` : '';
            return `  ${m.name}(${params})${returns} - ${m.description}`;
          })
          .join('\n');
        return `Interface: ${iface.name} (${iface.id})
${iface.description}
Methods:
${methods}`;
      })
      .join('\n\n');
  }

  /**
   * Format a type declaration.
   */
  private formatType(type: { kind: string; primitive?: string; reference?: string; elementType?: unknown }): string {
    switch (type.kind) {
      case 'primitive':
        return type.primitive ?? 'unknown';
      case 'reference':
        return type.reference ?? 'unknown';
      case 'array':
        return `Array<${this.formatType(type.elementType as { kind: string; primitive?: string; reference?: string; elementType?: unknown })}>`;
      default:
        return 'unknown';
    }
  }

  /**
   * Get the proxy template code.
   */
  private getProxyTemplate(): string {
    return `
import { Abject, AbjectOptions } from '../core/abject.js';
import { AbjectMessage, AbjectId } from '../core/types.js';
import { request, reply, error, isRequest } from '../core/message.js';

export class GeneratedProxy extends Abject {
  private sourceId: AbjectId;
  private targetId: AbjectId;

  constructor(sourceId: AbjectId, targetId: AbjectId, options: AbjectOptions) {
    super(options);
    this.sourceId = sourceId;
    this.targetId = targetId;
    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Handle all incoming messages
    this.on('*', async (msg: AbjectMessage) => {
      return this.translate(msg);
    });
  }

  private async translate(msg: AbjectMessage): Promise<unknown> {
    // Transform and forward message
    // Return transformed response
  }
}
`;
  }

  /**
   * Create a manifest for the generated proxy.
   */
  private createProxyManifest(
    sourceManifest: AbjectManifest,
    targetManifest: AbjectManifest
  ): AbjectManifest {
    return {
      name: `Proxy_${sourceManifest.name}_${targetManifest.name}`,
      description: `LLM-generated proxy that translates between ${sourceManifest.name} and ${targetManifest.name}`,
      version: '1.0.0',
      interfaces: [
        // Expose both source and target interfaces
        ...sourceManifest.interfaces.map((i) => ({
          ...i,
          id: `proxy:${i.id}`,
        })),
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
