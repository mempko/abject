/**
 * Health Monitor - tracks error rates and triggers proxy regeneration.
 */

import {
  AbjectId,
  AbjectMessage,
  AgreementId,
  AbjectError,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { require, invariant } from '../core/contracts.js';
import { event } from '../core/message.js';
import { Negotiator } from './negotiator.js';

const HEALTH_MONITOR_INTERFACE = 'abjects:health-monitor';

export interface HealthConfig {
  errorThreshold: number; // Error rate percentage to trigger renegotiation
  windowSize: number; // Rolling window size in ms
  minMessages: number; // Minimum messages before calculating rate
  checkInterval: number; // How often to check health in ms
}

interface ConnectionHealth {
  agreementId: AgreementId;
  messageCount: number;
  errorCount: number;
  errors: Array<{ timestamp: number; error: AbjectError }>;
  lastCheck: number;
}

export interface HealthStatus {
  agreementId: AgreementId;
  healthy: boolean;
  errorRate: number;
  messageCount: number;
  errorCount: number;
  lastError?: AbjectError;
}

/**
 * Monitors connection health and triggers self-healing.
 */
export class HealthMonitor extends Abject {
  private health: Map<AgreementId, ConnectionHealth> = new Map();
  private negotiator?: Negotiator;
  private checkTimer?: ReturnType<typeof setInterval>;
  private readonly config: HealthConfig;

  constructor(config: Partial<HealthConfig> = {}) {
    super({
      manifest: {
        name: 'HealthMonitor',
        description:
          'Monitors connection health and triggers proxy regeneration when error rates exceed threshold.',
        version: '1.0.0',
        interfaces: [
          {
            id: HEALTH_MONITOR_INTERFACE,
            name: 'HealthMonitor',
            description: 'Connection health monitoring',
            methods: [
              {
                name: 'getStatus',
                description: 'Get health status for a connection',
                parameters: [
                  {
                    name: 'agreementId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Agreement to check',
                  },
                ],
                returns: { kind: 'reference', reference: 'HealthStatus' },
              },
              {
                name: 'getAllStatus',
                description: 'Get health status for all connections',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'HealthStatus' },
                },
              },
              {
                name: 'forceRenegotiate',
                description: 'Force renegotiation of a connection',
                parameters: [
                  {
                    name: 'agreementId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Agreement to renegotiate',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
            ],
            events: [
              {
                name: 'healthWarning',
                description: 'Connection health is degraded',
                payload: { kind: 'reference', reference: 'HealthStatus' },
              },
              {
                name: 'renegotiationTriggered',
                description: 'Automatic renegotiation was triggered',
                payload: { kind: 'primitive', primitive: 'string' },
              },
            ],
          },
        ],
        requiredCapabilities: [],
        tags: ['system', 'health', 'monitoring'],
      },
    });

    this.config = {
      errorThreshold: config.errorThreshold ?? 10,
      windowSize: config.windowSize ?? 60000, // 1 minute
      minMessages: config.minMessages ?? 10,
      checkInterval: config.checkInterval ?? 5000, // 5 seconds
    };

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.on('getStatus', async (msg: AbjectMessage) => {
      const { agreementId } = msg.payload as { agreementId: AgreementId };
      return this.getStatus(agreementId);
    });

    this.on('getAllStatus', async () => {
      return this.getAllStatus();
    });

    this.on('forceRenegotiate', async (msg: AbjectMessage) => {
      const { agreementId } = msg.payload as { agreementId: AgreementId };
      return this.triggerRenegotiation(agreementId, 'Forced by request');
    });
  }

  /**
   * Set the negotiator for triggering renegotiations.
   */
  setNegotiator(negotiator: Negotiator): void {
    this.negotiator = negotiator;
  }

  /**
   * Start monitoring.
   */
  startMonitoring(): void {
    if (this.checkTimer) {
      return;
    }

    this.checkTimer = setInterval(() => {
      this.checkAllHealth();
    }, this.config.checkInterval);

    console.log('[HEALTH] Monitoring started');
  }

  /**
   * Stop monitoring.
   */
  stopMonitoring(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
    console.log('[HEALTH] Monitoring stopped');
  }

  /**
   * Track a connection.
   */
  trackConnection(agreementId: AgreementId): void {
    if (!this.health.has(agreementId)) {
      this.health.set(agreementId, {
        agreementId,
        messageCount: 0,
        errorCount: 0,
        errors: [],
        lastCheck: Date.now(),
      });
    }
  }

  /**
   * Stop tracking a connection.
   */
  untrackConnection(agreementId: AgreementId): void {
    this.health.delete(agreementId);
  }

  /**
   * Record a successful message.
   */
  recordSuccess(agreementId: AgreementId): void {
    const health = this.health.get(agreementId);
    if (health) {
      health.messageCount++;
    }
  }

  /**
   * Record an error.
   */
  recordError(agreementId: AgreementId, error: AbjectError): void {
    const health = this.health.get(agreementId);
    if (health) {
      health.messageCount++;
      health.errorCount++;
      health.errors.push({ timestamp: Date.now(), error });
    }
  }

  /**
   * Get health status for a connection.
   */
  getStatus(agreementId: AgreementId): HealthStatus | undefined {
    const health = this.health.get(agreementId);
    if (!health) {
      return undefined;
    }

    this.pruneOldErrors(health);

    const errorRate =
      health.messageCount > 0
        ? (health.errorCount / health.messageCount) * 100
        : 0;

    return {
      agreementId,
      healthy: errorRate < this.config.errorThreshold,
      errorRate,
      messageCount: health.messageCount,
      errorCount: health.errorCount,
      lastError: health.errors[health.errors.length - 1]?.error,
    };
  }

  /**
   * Get health status for all connections.
   */
  getAllStatus(): HealthStatus[] {
    const statuses: HealthStatus[] = [];
    for (const agreementId of this.health.keys()) {
      const status = this.getStatus(agreementId);
      if (status) {
        statuses.push(status);
      }
    }
    return statuses;
  }

  /**
   * Check health of all connections.
   */
  private checkAllHealth(): void {
    for (const [agreementId, health] of this.health) {
      this.pruneOldErrors(health);

      // Need minimum messages to calculate rate
      if (health.messageCount < this.config.minMessages) {
        continue;
      }

      const errorRate = (health.errorCount / health.messageCount) * 100;

      if (errorRate >= this.config.errorThreshold) {
        console.warn(
          `[HEALTH] Connection ${agreementId} has ${errorRate.toFixed(1)}% error rate`
        );

        // Build error context
        const recentErrors = health.errors.slice(-5);
        const errorContext = recentErrors
          .map((e) => `${e.error.code}: ${e.error.message}`)
          .join('\n');

        // Trigger renegotiation
        this.triggerRenegotiation(agreementId, errorContext);

        // Reset counters after renegotiation
        health.messageCount = 0;
        health.errorCount = 0;
        health.errors = [];
      }

      health.lastCheck = Date.now();
    }
  }

  /**
   * Prune errors outside the rolling window.
   */
  private pruneOldErrors(health: ConnectionHealth): void {
    const cutoff = Date.now() - this.config.windowSize;
    const originalCount = health.errors.length;

    health.errors = health.errors.filter((e) => e.timestamp > cutoff);

    // Adjust error count
    const pruned = originalCount - health.errors.length;
    health.errorCount = Math.max(0, health.errorCount - pruned);
  }

  /**
   * Trigger renegotiation for a connection.
   */
  private async triggerRenegotiation(
    agreementId: AgreementId,
    errorContext: string
  ): Promise<boolean> {
    if (!this.negotiator) {
      console.error('[HEALTH] No negotiator set, cannot renegotiate');
      return false;
    }

    console.log(`[HEALTH] Triggering renegotiation for ${agreementId}`);

    // Notify listeners
    await this.send(
      event(
        this.id,
        this.id, // Self-notification for logging
        HEALTH_MONITOR_INTERFACE,
        'renegotiationTriggered',
        agreementId
      )
    );

    try {
      const result = await this.negotiator.renegotiate(agreementId, errorContext);
      return result.success;
    } catch (err) {
      console.error('[HEALTH] Renegotiation failed:', err);
      return false;
    }
  }

  /**
   * Check if a connection is healthy.
   */
  isHealthy(agreementId: AgreementId): boolean {
    const status = this.getStatus(agreementId);
    return status?.healthy ?? true;
  }

  /**
   * Get tracked connection count.
   */
  get connectionCount(): number {
    return this.health.size;
  }

  /**
   * Clear all health data.
   */
  clear(): void {
    this.health.clear();
  }
}

// Well-known health monitor ID
export const HEALTH_MONITOR_ID = 'abjects:health-monitor' as AbjectId;

/**
 * Error types that indicate protocol incomprehension.
 */
export const INCOMPREHENSION_ERRORS = [
  'PARSE_ERROR',
  'UNKNOWN_METHOD',
  'INVALID_PAYLOAD',
  'SCHEMA_MISMATCH',
  'TYPE_ERROR',
  'SEMANTIC_ERROR',
];

/**
 * Check if an error indicates incomprehension.
 */
export function isIncomprehensionError(error: AbjectError): boolean {
  return INCOMPREHENSION_ERRORS.includes(error.code);
}
