/**
 * Protocol Negotiator - handles connection flow and proxy insertion.
 */

import {
  AbjectId,
  AbjectManifest,
  AbjectMessage,
  ProtocolAgreement,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require } from '../core/contracts.js';
import { event } from '../core/message.js';
import { Registry } from '../objects/registry.js';
import { Factory } from '../objects/factory.js';
import {
  ProxyGenerator,
  GeneratedProxy,

} from '../objects/proxy-generator.js';
import { MessageBus, ProxyInterceptor } from '../runtime/message-bus.js';

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
}

/**
 * The Negotiator handles the connection flow between objects.
 */
export class Negotiator extends Abject {
  private registry?: Registry;
  private factory?: Factory;
  private proxyGenerator?: ProxyGenerator;
  private bus?: MessageBus;
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
  }

  /**
   * Set dependencies.
   */
  setDependencies(
    registry: Registry,
    factory: Factory,
    proxyGenerator: ProxyGenerator,
    bus: MessageBus
  ): void {
    this.registry = registry;
    this.factory = factory;
    this.proxyGenerator = proxyGenerator;
    this.bus = bus;
  }

  /**
   * Establish a connection between two objects.
   */
  async connect(sourceId: AbjectId, targetId: AbjectId): Promise<ConnectionResult> {
    require(this.registry !== undefined, 'Registry not set');
    require(this.proxyGenerator !== undefined, 'ProxyGenerator not set');

    try {
      // Fetch manifests
      const sourceReg = this.registry!.lookupObject(sourceId);
      const targetReg = this.registry!.lookupObject(targetId);

      if (!sourceReg) {
        return { success: false, error: `Source object ${sourceId} not found` };
      }
      if (!targetReg) {
        return { success: false, error: `Target object ${targetId} not found` };
      }

      const sourceManifest = sourceReg.manifest;
      const targetManifest = targetReg.manifest;

      // Check if interfaces are compatible
      const compatible = this.checkCompatibility(sourceManifest, targetManifest);

      let agreement: ProtocolAgreement;
      let proxyId: AbjectId | undefined;

      if (compatible) {
        // Direct connection - no proxy needed
        agreement = this.createDirectAgreement(sourceId, targetId);
      } else {
        // Generate proxy
        const generated = await this.proxyGenerator!.generateProxy(
          sourceId,
          targetId,
          sourceManifest,
          targetManifest
        );

        // Spawn proxy object
        // Note: In a full implementation, we'd compile the generated code to WASM
        // For now, we create a simple pass-through proxy
        proxyId = await this.spawnProxy(generated, sourceId, targetId);

        agreement = generated.agreement;
        agreement.proxyId = proxyId;

        // Install proxy interceptor
        if (this.bus && proxyId) {
          const interceptor = new ProxyInterceptor(sourceId, targetId, proxyId);
          this.bus.addInterceptor(interceptor);
          this.connections.set(agreement.agreementId, {
            agreement,
            proxyId,
            interceptor,
          });
        }
      }

      // Store connection
      this.connections.set(agreement.agreementId, {
        agreement,
        proxyId,
      });

      // Notify
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

    // Remove interceptor
    if (connection.interceptor && this.bus) {
      this.bus.removeInterceptor(connection.interceptor);
    }

    // Kill proxy if exists
    if (connection.proxyId && this.factory) {
      await this.factory.kill(connection.proxyId);
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
    require(this.proxyGenerator !== undefined, 'ProxyGenerator not set');

    const connection = this.connections.get(agreementId);
    if (!connection) {
      return { success: false, error: 'Agreement not found' };
    }

    try {
      // Regenerate proxy
      const regenerated = await this.proxyGenerator!.regenerateProxy(
        agreementId,
        errorContext
      );

      // Hot-swap proxy
      if (connection.proxyId && this.factory) {
        await this.factory.kill(connection.proxyId);
      }

      const proxyId = await this.spawnProxy(
        regenerated,
        connection.agreement.participants[0],
        connection.agreement.participants[1]
      );

      // Update connection
      connection.proxyId = proxyId;
      connection.agreement = regenerated.agreement;
      connection.agreement.proxyId = proxyId;

      // Update interceptor
      if (this.bus) {
        if (connection.interceptor) {
          this.bus.removeInterceptor(connection.interceptor);
        }
        const interceptor = new ProxyInterceptor(
          connection.agreement.participants[0],
          connection.agreement.participants[1],
          proxyId
        );
        this.bus.addInterceptor(interceptor);
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
   * Check if two manifests have compatible interfaces.
   */
  private checkCompatibility(
    source: AbjectManifest,
    target: AbjectManifest
  ): boolean {
    // Simple compatibility check: do they share any interface IDs?
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
   * Spawn a proxy object.
   */
  private async spawnProxy(
    generated: GeneratedProxy,
    sourceId: AbjectId,
    targetId: AbjectId
  ): Promise<AbjectId> {
    // In a full implementation, we'd compile the generated TypeScript to WASM
    // For now, create a simple pass-through proxy using a built-in class
    const proxyId = `proxy-${sourceId}-${targetId}-${Date.now()}` as AbjectId;

    // The proxy would be spawned through the factory
    // For demonstration, we'll just return the ID
    // The actual proxy behavior is handled by the ProxyInterceptor

    return proxyId;
  }

  /**
   * Notify that a connection was established.
   */
  private async notifyConnectionEstablished(
    agreement: ProtocolAgreement
  ): Promise<void> {
    // Notify both participants
    for (const participantId of agreement.participants) {
      await this.send(
        event(
          this.id,
          participantId,
          NEGOTIATOR_INTERFACE,
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
