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
import { Log } from '../core/timed-log.js';

const log = new Log('PROXY-GEN');
import { IntrospectResult } from '../core/introspect.js';
import { ScriptableAbject } from './scriptable-abject.js';
import { systemMessage, userMessage, LLMMessage, LLMCompletionResult, LLMCompletionOptions } from '../llm/provider.js';

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
  private proxyMeta: Map<string, { sourceId: AbjectId; targetId: AbjectId }> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'ProxyGenerator',
        description:
          'Generates proxy objects using LLM to translate between incompatible object interfaces.',
        version: '1.0.0',
        interface: {
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

  protected override async onInit(): Promise<void> {
    this.llmId = await this.requireDep('LLM');
  }

  /**
   * Call LLM complete via message passing.
   */
  private async llmComplete(messages: LLMMessage[], options?: LLMCompletionOptions): Promise<LLMCompletionResult> {
    return this.request<LLMCompletionResult>(
      request(this.id, this.llmId!, 'complete', { messages, options }),
      120000
    );
  }

  /**
   * Ask an object to describe itself via introspect protocol.
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
   * Ask an object for a usage guide via the ask protocol.
   */
  private async askObject(objectId: AbjectId, question: string): Promise<string | null> {
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

    // Ask both objects for usage guides via the ask protocol
    const askQuestion = 'How should a proxy use your methods? Give a concise guide with example this.call() invocations and any important constraints.';
    const [sourceGuide, targetGuide] = await Promise.all([
      this.askObject(sourceId, askQuestion),
      this.askObject(targetId, askQuestion),
    ]);

    // Generate handler map via LLM
    const handlerSource = await this.generateHandlerMap(
      sourceId, targetId, sourceDescription, targetDescription,
      sourceGuide, targetGuide
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
    this.proxyMeta.set(agreement.agreementId, { sourceId, targetId });

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

    // Re-ask both objects for updated usage guides
    const meta = this.proxyMeta.get(agreementId);
    let sourceGuide: string | null = null;
    let targetGuide: string | null = null;
    if (meta) {
      const askQuestion = 'How should a proxy use your methods? Give a concise guide with example this.call() invocations and any important constraints.';
      [sourceGuide, targetGuide] = await Promise.all([
        this.askObject(meta.sourceId, askQuestion),
        this.askObject(meta.targetId, askQuestion),
      ]);
    }

    const guideSection = sourceGuide || targetGuide
      ? `\n\nSOURCE USAGE GUIDE (from the object itself):\n${sourceGuide ?? 'Not available'}\n\nTARGET USAGE GUIDE (from the object itself):\n${targetGuide ?? 'Not available'}`
      : '';

    const result = await this.llmComplete([
      systemMessage(this.getProxySystemPrompt()),
      userMessage(`The previous proxy implementation had issues:
${errorContext}
${guideSection}

Previous handler map:
\`\`\`javascript
${existing!.handlerSource}
\`\`\`

Generate a corrected handler map that fixes these issues. Output ONLY the handler map in a \`\`\`javascript code block.`),
    ], { tier: 'smart' });

    let handlerSource = this.parseCodeResponse(result.content) ?? existing!.handlerSource;

    // Validate compilation
    const compileError = ScriptableAbject.tryCompile(handlerSource);
    if (compileError) {
      log.warn('Regenerated code failed to compile:', compileError);
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
    targetDescription: string,
    sourceGuide?: string | null,
    targetGuide?: string | null
  ): Promise<string> {
    const guideSection = sourceGuide || targetGuide
      ? `\n\nSOURCE USAGE GUIDE (from the object itself):\n${sourceGuide ?? 'Not available'}\n\nTARGET USAGE GUIDE (from the object itself):\n${targetGuide ?? 'Not available'}\n`
      : '';

    const result = await this.llmComplete([
      systemMessage(this.getProxySystemPrompt()),
      userMessage(`Generate a JavaScript handler map for a proxy that translates messages between two objects.

SOURCE OBJECT:
${sourceDescription}

TARGET OBJECT:
${targetDescription}
${guideSection}
The proxy receives messages from the source, translates them, and forwards to the target.
Use this.call(this.dep('target'), method, payload) to forward.
Use this.dep('source') and this.dep('target') for object IDs.

Output ONLY the handler map in a \`\`\`javascript code block.`),
    ], { tier: 'smart' });

    let handlerSource = this.parseCodeResponse(result.content);

    if (!handlerSource) {
      // Fallback: generate a simple pass-through proxy
      handlerSource = this.getFallbackHandlerMap();
    }

    // Validate compilation
    const compileError = ScriptableAbject.tryCompile(handlerSource);
    if (compileError) {
      log.warn('Generated code failed to compile, using fallback:', compileError);
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
    const result = await this.call(this.dep('target'), 'method', payload);
    return result;
  }
})

RULES:
- MUST be plain JavaScript (NOT TypeScript). No type annotations.
- Format: parenthesized object expression ({ ... })
- Each handler receives msg with msg.payload containing parameters
- Use this.call(this.dep('target'), method, payload) to forward to target
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
      return await this.call(this.dep('target'), method, msg.payload);
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
      interface: {
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
    this.proxyMeta.clear();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## ProxyGenerator Usage Guide

### Generate a proxy between two objects

  const result = await call(await dep('ProxyGenerator'), 'generateProxy', {
    sourceId: 'source-object-id', targetId: 'target-object-id',
    sourceDescription: 'optional usage guide', targetDescription: 'optional usage guide'
  });
  // result: { proxyId, agreementId }

The proxy is a ScriptableAbject that translates messages from source's protocol to target's protocol. If descriptions are not provided, ProxyGenerator auto-introspects both objects via their 'describe' handler.

### Regenerate a proxy after errors

  const result = await call(await dep('ProxyGenerator'), 'regenerateProxy', {
    agreementId: 'the-agreement-id', errorContext: 'TypeError: expected number got string'
  });
  // result: { proxyId, agreementId }

This re-generates the proxy code with the error context so the LLM can fix the translation issue.

### IMPORTANT
- The interface ID is 'abjects:proxy-generator'.
- Proxy generation uses the LLM and may take several seconds.
- Generated proxies are cached by agreement ID — regenerateProxy replaces the cached version.`;
  }
}

// Well-known proxy generator ID
export const PROXY_GENERATOR_ID = 'abjects:proxy-generator' as AbjectId;
