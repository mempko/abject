/**
 * Protocol Negotiator - handles connection flow and proxy insertion.
 *
 * Uses message passing internally — no direct object references.
 * Spawns real ScriptableAbject proxies via Factory.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
  ProtocolAgreement,
  SpawnResult,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require } from '../core/contracts.js';
import { request, event } from '../core/message.js';
import { INTROSPECT_INTERFACE_ID, IntrospectResult } from '../core/introspect.js';
import { GeneratedProxy } from '../objects/proxy-generator.js';
import { ProxyInterceptor, MessageBus } from '../runtime/message-bus.js';

const NEGOTIATOR_INTERFACE = 'abjects:negotiator';

export interface ConnectionRequest {
  sourceId: AbjectId;
  targetId: AbjectId;
}

export interface ConnectionResult {
  success: boolean;
  agreementId?: string;
  proxyId?: AbjectId;
  error?: string;
}

interface ActiveConnection {
  agreement: ProtocolAgreement;
  proxyId?: AbjectId;
  interceptor?: ProxyInterceptor;
  sourceId: AbjectId;
  targetId: AbjectId;
}

/**
 * The Negotiator handles the connection flow between objects.
 * Uses message passing for all dependencies.
 */
export class Negotiator extends Abject {
  private registryId?: AbjectId;
  private factoryId?: AbjectId;
  private proxyGeneratorId?: AbjectId;
  private healthMonitorId?: AbjectId;
  private connections: Map<string, ActiveConnection> = new Map();

  constructor() {
    super({
      manifest: {
        name: 'Negotiator',
        description:
          'Handles connection establishment between objects, generating proxies when needed.',
        version: '1.0.0',
        interfaces: [
          {
            id: NEGOTIATOR_INTERFACE,
            name: 'Negotiator',
            description: 'Connection negotiation',
            methods: [
              {
                name: 'connect',
                description: 'Establish a connection between two objects',
                parameters: [
                  {
                    name: 'sourceId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Source object',
                  },
                  {
                    name: 'targetId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Target object',
                  },
                ],
                returns: { kind: 'reference', reference: 'ConnectionResult' },
              },
              {
                name: 'disconnect',
                description: 'Terminate a connection',
                parameters: [
                  {
                    name: 'agreementId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Agreement to terminate',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'renegotiate',
                description: 'Renegotiate a connection due to errors',
                parameters: [
                  {
                    name: 'agreementId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Agreement to renegotiate',
                  },
                  {
                    name: 'errorContext',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'What went wrong',
                  },
                ],
                returns: { kind: 'reference', reference: 'ConnectionResult' },
              },
            ],
            events: [
              {
                name: 'connectionEstablished',
                description: 'Connection was established',
                payload: { kind: 'reference', reference: 'ProtocolAgreement' },
              },
              {
                name: 'connectionFailed',
                description: 'Connection failed',
                payload: { kind: 'primitive', primitive: 'string' },
              },
            ],
          },
        ],
        requiredCapabilities: [],
        tags: ['system', 'protocol'],
      },
    });

    this.setupHandlers();
  }

  protected override getSourceForAsk(): string | undefined {
    return `## Negotiator Usage Guide

### Connect two objects

  const result = await this.call(this.dep('Negotiator'), 'abjects:negotiator', 'connect',
    { sourceId: objectA, targetId: objectB });
  // result: { success, agreementId?, proxyId?, error? }

The Negotiator introspects both objects, generates a proxy if their interfaces don't match, and establishes a tracked connection. This is how objects with different protocols can communicate.

### Disconnect

  await this.call(this.dep('Negotiator'), 'abjects:negotiator', 'disconnect',
    { agreementId: 'the-agreement-id' });

### Renegotiate (on errors)

  await this.call(this.dep('Negotiator'), 'abjects:negotiator', 'renegotiate',
    { agreementId: 'the-agreement-id', errorContext: 'method not found' });

### When to use
- After creating an object that depends on others (ObjectCreator does this automatically)
- When you want two independently-created objects to talk to each other
- When a connection fails and needs repair

### Events
- connectionEstablished: a new connection was set up
- connectionFailed: connection attempt failed`;
  }

  private setupHandlers(): void {
    this.on('connect', async (msg: AbjectMessage) => {
      const { sourceId, targetId } = msg.payload as ConnectionRequest;
      return this.connect(sourceId, targetId);
    });

    this.on('disconnect', async (msg: AbjectMessage) => {
      const { agreementId } = msg.payload as { agreementId: string };
      return this.disconnect(agreementId);
    });

    this.on('renegotiate', async (msg: AbjectMessage) => {
      const { agreementId, errorContext } = msg.payload as {
        agreementId: string;
        errorContext: string;
      };
      return this.renegotiate(agreementId, errorContext);
    });

    // Listen for sourceUpdated events from ScriptableAbjects (Step 5)
    this.on('sourceUpdated', async (msg: AbjectMessage) => {
      const changedId = msg.routing.from;
      await this.handleSourceUpdated(changedId);
    });
  }

  protected override async onInit(): Promise<void> {
    this.registryId = await this.requireDep('Registry');
    this.factoryId = await this.requireDep('Factory');
    this.proxyGeneratorId = await this.requireDep('ProxyGenerator');
    // HealthMonitor discovered lazily (circular dep — may not exist yet at init time)
  }

  /**
   * Introspect an object to get its description.
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
   * Establish a connection between two objects.
   */
  async connect(sourceId: AbjectId, targetId: AbjectId): Promise<ConnectionResult> {
    require(this.proxyGeneratorId !== undefined, 'ProxyGenerator not set');

    try {
      // Introspect both objects to learn their capabilities
      const sourceResult = await this.introspect(sourceId);
      const targetResult = await this.introspect(targetId);

      if (!sourceResult) {
        return { success: false, error: `Source object ${sourceId} not found or not introspectable` };
      }
      if (!targetResult) {
        return { success: false, error: `Target object ${targetId} not found or not introspectable` };
      }

      const sourceManifest = sourceResult.manifest;
      const targetManifest = targetResult.manifest;

      // Check if interfaces are compatible
      const compatible = this.checkCompatibility(sourceManifest, targetManifest);

      let agreement: ProtocolAgreement;
      let proxyId: AbjectId | undefined;

      if (compatible) {
        // Direct connection - no proxy needed
        agreement = this.createDirectAgreement(sourceId, targetId);
      } else {
        // Generate proxy via message passing to ProxyGenerator
        const generated = await this.request<GeneratedProxy>(
          request(this.id, this.proxyGeneratorId!, 'abjects:proxy-generator' as InterfaceId, 'generateProxy', {
            sourceId,
            targetId,
            sourceDescription: sourceResult.description,
            targetDescription: targetResult.description,
          })
        );

        // Spawn proxy as a real ScriptableAbject via Factory
        proxyId = await this.spawnProxy(generated, sourceId, targetId);

        agreement = generated.agreement;
        agreement.proxyId = proxyId;

        // Install proxy interceptor (requires main-thread MessageBus)
        if (this.bus && proxyId && this.bus instanceof MessageBus) {
          const interceptor = new ProxyInterceptor(sourceId, targetId, proxyId);
          (this.bus as MessageBus).addInterceptor(interceptor);
          this.connections.set(agreement.agreementId, {
            agreement,
            proxyId,
            interceptor,
            sourceId,
            targetId,
          });
        }
      }

      // Store connection (may overwrite if already set above with interceptor)
      if (!this.connections.has(agreement.agreementId)) {
        this.connections.set(agreement.agreementId, {
          agreement,
          proxyId,
          sourceId,
          targetId,
        });
      }

      // Notify HealthMonitor to track this connection (lazily discovered)
      if (!this.healthMonitorId) {
        this.healthMonitorId = await this.discoverDep('HealthMonitor') ?? undefined;
      }
      if (this.healthMonitorId && agreement.agreementId) {
        this.request(
          request(this.id, this.healthMonitorId, 'abjects:health-monitor' as InterfaceId, 'trackConnection', {
            agreementId: agreement.agreementId,
          })
        ).catch(() => { /* health monitor tracking is best-effort */ });
      }

      // Notify participants
      await this.notifyConnectionEstablished(agreement);

      return {
        success: true,
        agreementId: agreement.agreementId,
        proxyId,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Disconnect objects.
   */
  async disconnect(agreementId: string): Promise<boolean> {
    const connection = this.connections.get(agreementId);
    if (!connection) {
      return false;
    }

    // Remove interceptor (requires main-thread MessageBus)
    if (connection.interceptor && this.bus instanceof MessageBus) {
      (this.bus as MessageBus).removeInterceptor(connection.interceptor);
    }

    // Kill proxy via Factory message passing
    if (connection.proxyId && this.factoryId) {
      await this.request(
        request(this.id, this.factoryId, 'abjects:factory' as InterfaceId, 'kill', { objectId: connection.proxyId })
      ).catch(() => { /* proxy may already be dead */ });
    }

    this.connections.delete(agreementId);
    return true;
  }

  /**
   * Renegotiate a connection due to errors.
   */
  async renegotiate(
    agreementId: string,
    errorContext: string
  ): Promise<ConnectionResult> {
    require(this.proxyGeneratorId !== undefined, 'ProxyGenerator not set');

    const connection = this.connections.get(agreementId);
    if (!connection) {
      return { success: false, error: 'Agreement not found' };
    }

    try {
      // Regenerate proxy via message passing
      const regenerated = await this.request<GeneratedProxy>(
        request(this.id, this.proxyGeneratorId!, 'abjects:proxy-generator' as InterfaceId, 'regenerateProxy', {
          agreementId,
          errorContext,
        })
      );

      // Kill old proxy
      if (connection.proxyId && this.factoryId) {
        await this.request(
          request(this.id, this.factoryId, 'abjects:factory' as InterfaceId, 'kill', { objectId: connection.proxyId })
        ).catch(() => {});
      }

      // Spawn new proxy
      const proxyId = await this.spawnProxy(
        regenerated,
        connection.sourceId,
        connection.targetId
      );

      // Update connection
      connection.proxyId = proxyId;
      connection.agreement = regenerated.agreement;
      connection.agreement.proxyId = proxyId;

      // Update interceptor (requires main-thread MessageBus)
      if (this.bus instanceof MessageBus) {
        if (connection.interceptor) {
          (this.bus as MessageBus).removeInterceptor(connection.interceptor);
        }
        const interceptor = new ProxyInterceptor(
          connection.sourceId,
          connection.targetId,
          proxyId
        );
        (this.bus as MessageBus).addInterceptor(interceptor);
        connection.interceptor = interceptor;
      }

      return {
        success: true,
        agreementId,
        proxyId,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMsg };
    }
  }

  /**
   * Handle a sourceUpdated event — regenerate proxies for affected connections.
   */
  private async handleSourceUpdated(changedId: AbjectId): Promise<void> {
    for (const [agreementId, connection] of this.connections) {
      if (connection.sourceId === changedId || connection.targetId === changedId) {
        console.log(`[NEGOTIATOR] Source updated for ${changedId}, regenerating proxy for ${agreementId}`);
        // Re-introspect the changed object to learn its new interface
        const result = await this.introspect(changedId);
        const errorContext = result
          ? `Object ${changedId} interface changed. New description:\n${result.description}`
          : `Object ${changedId} interface changed.`;
        await this.renegotiate(agreementId, errorContext);
      }
    }
  }

  /**
   * Check if two manifests have compatible interfaces.
   */
  private checkCompatibility(
    source: { interfaces: Array<{ id: string }> },
    target: { interfaces: Array<{ id: string }> }
  ): boolean {
    const sourceIds = new Set(source.interfaces.map((i) => i.id));
    return target.interfaces.some((i) => sourceIds.has(i.id));
  }

  /**
   * Create a direct agreement (no proxy).
   */
  private createDirectAgreement(
    sourceId: AbjectId,
    targetId: AbjectId
  ): ProtocolAgreement {
    return {
      agreementId: `direct-${sourceId}-${targetId}-${Date.now()}`,
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
   * Spawn a proxy ScriptableAbject via Factory message passing.
   */
  private async spawnProxy(
    generated: GeneratedProxy,
    sourceId: AbjectId,
    targetId: AbjectId
  ): Promise<AbjectId> {
    if (!this.factoryId) {
      // Fallback: return a placeholder ID
      return `proxy-${sourceId}-${targetId}-${Date.now()}` as AbjectId;
    }

    const spawnResult = await this.request<SpawnResult>(
      request(this.id, this.factoryId, 'abjects:factory' as InterfaceId, 'spawn', {
        manifest: generated.proxyManifest,
        source: generated.handlerSource,
        owner: this.id,
        deps: { source: sourceId, target: targetId },
      })
    );

    return spawnResult.objectId;
  }

  /**
   * Notify that a connection was established.
   */
  private async notifyConnectionEstablished(
    agreement: ProtocolAgreement
  ): Promise<void> {
    for (const participantId of agreement.participants) {
      await this.send(
        event(
          this.id,
          participantId,
          NEGOTIATOR_INTERFACE as InterfaceId,
          'connectionEstablished',
          agreement
        )
      );
    }
  }

  /**
   * Get active connection count.
   */
  get connectionCount(): number {
    return this.connections.size;
  }

  /**
   * Get connection by agreement ID.
   */
  getConnection(agreementId: string): ActiveConnection | undefined {
    return this.connections.get(agreementId);
  }
}

// Well-known negotiator ID
export const NEGOTIATOR_ID = 'abjects:negotiator' as AbjectId;
