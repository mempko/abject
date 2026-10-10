/**
 * Protocol Negotiator - handles connection flow and proxy insertion.
 *
 * Connecting two objects whose interfaces differ spawns a proxy (a real
 * ScriptableAbject, written by ProxyGenerator) and installs a proxy route on
 * the main bus, which copies it to every pool worker (src/runtime/
 * proxy-routes.ts): traffic between the two then goes through the proxy
 * wherever they run, and neither object knows. The Negotiator runs on the
 * main thread for that reason; everything else it does is message passing.
 *
 * A connection heals itself two ways: HealthMonitor counts the proxy's
 * answers and asks for `renegotiate` when too many are errors, and either
 * end announcing `sourceUpdated` (it is a dependent of both) regenerates the
 * proxy against the new interface.
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
import { Log } from '../core/timed-log.js';

const log = new Log('NEGOTIATOR');
import { IntrospectResult } from '../core/introspect.js';
import { GeneratedProxy } from '../objects/proxy-generator.js';
import { MessageBus } from '../runtime/message-bus.js';

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
        interface: {
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
        tags: ['system', 'protocol'],
      },
    });

    this.setupHandlers();
  }

  protected override askPrompt(_question: string): string {
    return super.askPrompt(_question) + `\n\n## Negotiator Usage Guide

### Connect two objects

  const result = await this.call(this.dep('Negotiator'), 'connect',
    { sourceId: objectA, targetId: objectB });
  // result: { success, agreementId?, proxyId?, error? }

The Negotiator introspects both objects, generates a proxy if their interfaces don't match, and establishes a tracked connection. This is how objects with different protocols can communicate.

### Disconnect

  await this.call(this.dep('Negotiator'), 'disconnect',
    { agreementId: 'the-agreement-id' });

### Renegotiate (on errors)

  await this.call(this.dep('Negotiator'), 'renegotiate',
    { agreementId: 'the-agreement-id', errorContext: 'method not found' });

### When to use
- When you want two independently-created objects to talk to each other and
  their interfaces differ: the source keeps calling the target as it always
  did, and the proxy translates in between
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

    // Either end of a connection announces a source change to its
    // dependents; the Negotiator became one when it connected them.
    this.on('sourceUpdated', async (msg: AbjectMessage) => {
      const changedId = msg.routing.from;
      await this.handleSourceUpdated(changedId);
    });
  }

  protected override async onInit(): Promise<void> {
    require(this.bus instanceof MessageBus,
      'Negotiator runs on the main thread: it installs proxy routes on the main bus');
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
        request(this.id, objectId, 'describe', {})
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
          request(this.id, this.proxyGeneratorId!, 'generateProxy', {
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
      }

      this.connections.set(agreement.agreementId, { agreement, proxyId, sourceId, targetId });

      // HealthMonitor (lazily discovered: it spawns after us) tracks the
      // connection and receives the proxy's answers through the route.
      this.healthMonitorId = await this.resolveDep('HealthMonitor', this.healthMonitorId);
      if (proxyId) this.installRoute(agreement.agreementId, sourceId, targetId, proxyId);

      // Hear about source changes at either end.
      for (const id of [sourceId, targetId]) {
        this.request(request(this.id, id, 'addDependent', {})).catch(() => { /* gone already */ });
      }

      if (this.healthMonitorId && agreement.agreementId) {
        this.request(
          request(this.id, this.healthMonitorId, 'trackConnection', {
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
      for (const id of [sourceId, targetId]) {
        this.send(event(this.id, id, 'connectionFailed', errorMsg));
      }
      return { success: false, error: errorMsg };
    }
  }

  /** Route the connection through its proxy on every bus (src/runtime/proxy-routes.ts). */
  private installRoute(agreementId: string, sourceId: AbjectId, targetId: AbjectId, proxyId: AbjectId): void {
    (this.bus as MessageBus).setProxyRoute({
      agreementId, sourceId, targetId, proxyId,
      ...(this.healthMonitorId ? { healthMonitorId: this.healthMonitorId } : {}),
    });
  }

  /**
   * Disconnect objects.
   */
  async disconnect(agreementId: string): Promise<boolean> {
    const connection = this.connections.get(agreementId);
    if (!connection) {
      return false;
    }

    if (connection.proxyId) (this.bus as MessageBus).removeProxyRoute(agreementId);
    for (const id of [connection.sourceId, connection.targetId]) {
      if (this.isStillConnected(id, agreementId)) continue;
      this.request(request(this.id, id, 'removeDependent', {})).catch(() => { /* gone already */ });
    }

    // Kill proxy via Factory message passing
    if (connection.proxyId && this.factoryId) {
      await this.request(
        request(this.id, this.factoryId, 'kill', { objectId: connection.proxyId })
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
        request(this.id, this.proxyGeneratorId!, 'regenerateProxy', {
          agreementId,
          errorContext,
        })
      );

      // Kill old proxy
      if (connection.proxyId && this.factoryId) {
        await this.request(
          request(this.id, this.factoryId, 'kill', { objectId: connection.proxyId })
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

      // Point the route at the new proxy (replaces the old one everywhere).
      this.healthMonitorId = await this.resolveDep('HealthMonitor', this.healthMonitorId);
      this.installRoute(agreementId, connection.sourceId, connection.targetId, proxyId);

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
    for (const [agreementId, connection] of [...this.connections]) {
      if (connection.sourceId !== changedId && connection.targetId !== changedId) continue;
      if (!connection.proxyId) {
        // A direct connection: it needs a proxy only if the interfaces no
        // longer match, and connecting afresh decides that.
        log.info(`Source updated for ${changedId}; rechecking direct connection ${agreementId}`);
        await this.disconnect(agreementId);
        await this.connect(connection.sourceId, connection.targetId);
        continue;
      }
      {
        log.info(`Source updated for ${changedId}, regenerating proxy for ${agreementId}`);
        // Re-introspect the changed object to learn its new interface
        const result = await this.introspect(changedId);
        const errorContext = result
          ? `Object ${changedId} interface changed. New description:\n${result.description}`
          : `Object ${changedId} interface changed.`;
        await this.renegotiate(agreementId, errorContext);
      }
    }
  }

  /** Whether an object is an end of some connection other than this one. */
  private isStillConnected(id: AbjectId, exceptAgreementId: string): boolean {
    for (const [agreementId, c] of this.connections) {
      if (agreementId !== exceptAgreementId && (c.sourceId === id || c.targetId === id)) return true;
    }
    return false;
  }

  /**
   * Check if two manifests have compatible interfaces.
   */
  private checkCompatibility(
    source: { interface: { id: string } },
    target: { interface: { id: string } }
  ): boolean {
    return source.interface.id === target.interface.id;
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
      request(this.id, this.factoryId, 'spawn', {
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
      this.send(
        event(
          this.id,
          participantId,
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
