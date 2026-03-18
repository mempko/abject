/**
 * Health Monitor - tracks error rates, triggers proxy regeneration,
 * and monitors object liveness via periodic ping.
 *
 * Uses message passing for all dependencies — no direct object references.
 * Exposes message handlers for error tracking so the HealthInterceptor
 * can report errors passively.
 *
 * Object liveness: periodically pings monitored objects. After N consecutive
 * failures, notifies the Supervisor to restart the dead object.
 */

import {
  AbjectId,
  AbjectMessage,
  InterfaceId,
  AgreementId,
  AbjectError,
} from '../core/types.js';
import { Abject } from '../core/abject.js';
import { request, event } from '../core/message.js';
import { Log } from '../core/timed-log.js';

const log = new Log('HEALTH');

const HEALTH_MONITOR_INTERFACE = 'abjects:health-monitor';

export interface HealthConfig {
  errorThreshold: number; // Error rate percentage to trigger renegotiation
  windowSize: number; // Rolling window size in ms
  minMessages: number; // Minimum messages before calculating rate
  checkInterval: number; // How often to check health in ms
  pingTimeout: number; // Timeout for liveness pings in ms
  maxPingFailures: number; // Consecutive failures before declaring dead
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

interface ObjectLiveness {
  objectId: AbjectId;
  ready: boolean;
  consecutiveFailures: number;
  maxFailures: number;
  lastPingAt: number;
  lastPongAt: number;
}

export interface ObjectLivenessStatus {
  objectId: AbjectId;
  alive: boolean;
  consecutiveFailures: number;
  maxFailures: number;
  lastPingAt: number;
  lastPongAt: number;
}

/**
 * Monitors connection health and object liveness, triggers self-healing.
 * Uses message passing to Negotiator for renegotiation and Supervisor for restarts.
 */
export class HealthMonitor extends Abject {
  private health: Map<AgreementId, ConnectionHealth> = new Map();
  private monitoredObjects: Map<AbjectId, ObjectLiveness> = new Map();
  private negotiatorId?: AbjectId;
  private supervisorId?: AbjectId;
  private checkTimer?: ReturnType<typeof setInterval>;
  private _checkingLiveness = false;
  private readonly config: HealthConfig;

  constructor(config: Partial<HealthConfig> = {}) {
    super({
      manifest: {
        name: 'HealthMonitor',
        description:
          'Monitors connection health and object liveness. Triggers proxy regeneration when error rates exceed threshold and notifies Supervisor when objects stop responding to pings.',
        version: '1.0.0',
        interface: {
            id: HEALTH_MONITOR_INTERFACE,
            name: 'HealthMonitor',
            description: 'Connection health and object liveness monitoring',
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
              {
                name: 'trackConnection',
                description: 'Start tracking a connection',
                parameters: [
                  {
                    name: 'agreementId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Agreement to track',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'recordSuccess',
                description: 'Record a successful message on a connection',
                parameters: [
                  {
                    name: 'agreementId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Agreement ID',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'recordError',
                description: 'Record an error on a connection',
                parameters: [
                  {
                    name: 'agreementId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Agreement ID',
                  },
                  {
                    name: 'error',
                    type: { kind: 'reference', reference: 'AbjectError' },
                    description: 'The error that occurred',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'monitorObject',
                description: 'Start monitoring an object for liveness',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Object to monitor',
                  },
                  {
                    name: 'maxFailures',
                    type: { kind: 'primitive', primitive: 'number' },
                    description: 'Consecutive ping failures before declaring dead',
                    optional: true,
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'unmonitorObject',
                description: 'Stop monitoring an object for liveness',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Object to stop monitoring',
                  },
                ],
                returns: { kind: 'primitive', primitive: 'boolean' },
              },
              {
                name: 'getObjectLiveness',
                description: 'Get liveness status for a monitored object',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Object to check',
                  },
                ],
                returns: { kind: 'reference', reference: 'ObjectLivenessStatus' },
              },
              {
                name: 'getAllObjectLiveness',
                description: 'Get liveness status for all monitored objects',
                parameters: [],
                returns: {
                  kind: 'array',
                  elementType: { kind: 'reference', reference: 'ObjectLivenessStatus' },
                },
              },
              {
                name: 'markObjectReady',
                description: 'Mark a monitored object as ready for liveness pings',
                parameters: [
                  {
                    name: 'objectId',
                    type: { kind: 'primitive', primitive: 'string' },
                    description: 'Object to mark as ready',
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
              {
                name: 'objectDead',
                description: 'A monitored object stopped responding to pings',
                payload: { kind: 'primitive', primitive: 'string' },
              },
            ],
          },
        requiredCapabilities: [],
        tags: ['system', 'health', 'monitoring'],
      },
    });

    this.config = {
      errorThreshold: config.errorThreshold ?? 10,
      windowSize: config.windowSize ?? 60000, // 1 minute
      minMessages: config.minMessages ?? 10,
      checkInterval: config.checkInterval ?? 5000, // 5 seconds
      pingTimeout: config.pingTimeout ?? 5000, // 5 second ping timeout
      maxPingFailures: config.maxPingFailures ?? 36,
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

    this.on('trackConnection', async (msg: AbjectMessage) => {
      const { agreementId } = msg.payload as { agreementId: AgreementId };
      this.trackConnection(agreementId);
      return true;
    });

    this.on('recordSuccess', async (msg: AbjectMessage) => {
      const { agreementId } = msg.payload as { agreementId: AgreementId };
      this.recordSuccess(agreementId);
      return true;
    });

    this.on('recordError', async (msg: AbjectMessage) => {
      const { agreementId, error } = msg.payload as { agreementId: AgreementId; error: AbjectError };
      this.recordError(agreementId, error);
      return true;
    });

    this.on('startMonitoring', async () => {
      this.startMonitoring();
      return true;
    });

    // Object liveness handlers
    this.on('monitorObject', async (msg: AbjectMessage) => {
      const { objectId, maxFailures } = msg.payload as {
        objectId: AbjectId;
        maxFailures?: number;
      };
      this.monitorObject(objectId, maxFailures);
      return true;
    });

    this.on('unmonitorObject', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      this.unmonitorObject(objectId);
      return true;
    });

    this.on('getObjectLiveness', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      return this.getObjectLiveness(objectId);
    });

    this.on('getAllObjectLiveness', async () => {
      return this.getAllObjectLiveness();
    });

    this.on('markObjectReady', async (msg: AbjectMessage) => {
      const { objectId } = msg.payload as { objectId: AbjectId };
      this.markObjectReady(objectId);
      return true;
    });

    this.on('objectUnregistered', async (msg: AbjectMessage) => {
      const objectId = msg.payload as AbjectId;
      this.unmonitorObject(objectId);
    });
  }

  protected override async onInit(): Promise<void> {
    // Discover Negotiator (for connection renegotiation)
    try {
      this.negotiatorId = await this.requireDep('Negotiator');
    } catch {
      // Negotiator may not be spawned yet — that's OK
    }

    // Discover Supervisor (for liveness failure escalation)
    try {
      const sid = await this.discoverDep('Supervisor');
      if (sid) this.supervisorId = sid;
    } catch {
      // Supervisor may not be spawned yet — that's OK
    }

    // Subscribe to Registry for object-deletion cleanup
    const registryId = await this.discoverDep('Registry');
    if (registryId) {
      try {
        await this.request(request(this.id, registryId,
          'subscribe', {}));
      } catch { /* best effort */ }
    }
  }

  /**
   * Start monitoring (connection health + object liveness).
   */
  startMonitoring(): void {
    if (this.checkTimer) {
      return;
    }

    this.checkTimer = setInterval(() => {
      this.checkAllHealth();
      this.checkObjectLiveness();
    }, this.config.checkInterval);

    log.info('Monitoring started');
  }

  /**
   * Stop monitoring.
   */
  stopMonitoring(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
    log.info('Monitoring stopped');
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
   * Start monitoring an object for liveness.
   */
  monitorObject(objectId: AbjectId, maxFailures?: number): void {
    if (this.monitoredObjects.has(objectId)) return;

    this.monitoredObjects.set(objectId, {
      objectId,
      ready: false,
      consecutiveFailures: 0,
      maxFailures: maxFailures ?? this.config.maxPingFailures,
      lastPingAt: 0,
      lastPongAt: 0,
    });
  }

  /**
   * Mark a monitored object as ready for liveness pings.
   */
  markObjectReady(objectId: AbjectId): void {
    const liveness = this.monitoredObjects.get(objectId);
    if (liveness) liveness.ready = true;
  }

  /**
   * Stop monitoring an object for liveness.
   */
  unmonitorObject(objectId: AbjectId): void {
    this.monitoredObjects.delete(objectId);
  }

  /**
   * Get liveness status for a monitored object.
   */
  getObjectLiveness(objectId: AbjectId): ObjectLivenessStatus | undefined {
    const liveness = this.monitoredObjects.get(objectId);
    if (!liveness) return undefined;

    return {
      objectId: liveness.objectId,
      alive: liveness.consecutiveFailures < liveness.maxFailures,
      consecutiveFailures: liveness.consecutiveFailures,
      maxFailures: liveness.maxFailures,
      lastPingAt: liveness.lastPingAt,
      lastPongAt: liveness.lastPongAt,
    };
  }

  /**
   * Get liveness status for all monitored objects.
   */
  getAllObjectLiveness(): ObjectLivenessStatus[] {
    const statuses: ObjectLivenessStatus[] = [];
    for (const objectId of this.monitoredObjects.keys()) {
      const status = this.getObjectLiveness(objectId);
      if (status) statuses.push(status);
    }
    return statuses;
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
        log.warn(
          `Connection ${agreementId} has ${errorRate.toFixed(1)}% error rate`
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
   * Check liveness of all monitored objects via ping.
   * Guarded against concurrent invocations from overlapping setInterval callbacks.
   */
  private async checkObjectLiveness(): Promise<void> {
    if (this._checkingLiveness) return;
    this._checkingLiveness = true;
    try {
      await this.checkObjectLivenessInner();
    } finally {
      this._checkingLiveness = false;
    }
  }

  private async checkObjectLivenessInner(): Promise<void> {
    for (const [objectId, liveness] of this.monitoredObjects) {
      // Don't ping ourselves
      if (objectId === this.id) continue;
      // Skip objects that haven't confirmed readiness yet
      if (!liveness.ready) continue;

      liveness.lastPingAt = Date.now();
      try {
        await this.request(
          request(this.id, objectId, 'ping', {}),
          this.config.pingTimeout
        );
        liveness.lastPongAt = Date.now();
        liveness.consecutiveFailures = 0;
      } catch {
        liveness.consecutiveFailures++;
        if (liveness.consecutiveFailures >= liveness.maxFailures) {
          log.warn(
            `Object ${objectId} did not respond to ${liveness.maxFailures} consecutive pings`
          );
          // Gate the object so it won't be pinged again until
          // markObjectReady is called after the restart completes.
          liveness.ready = false;
          await this.notifySupervisor(objectId, liveness.maxFailures);
          liveness.consecutiveFailures = 0; // reset after notification
        }
      }
    }
  }

  /**
   * Notify Supervisor that an object is dead.
   */
  private async notifySupervisor(objectId: AbjectId, maxFailures: number): Promise<void> {
    // Lazily discover Supervisor if not found at init time
    if (!this.supervisorId) {
      try {
        const sid = await this.discoverDep('Supervisor');
        if (sid) this.supervisorId = sid;
      } catch {
        // Still no Supervisor
      }
    }

    if (!this.supervisorId) {
      log.warn('No Supervisor available to handle dead object');
      return;
    }

    try {
      this.send(event(this.id, this.supervisorId,
        'childFailed', {
          childId: objectId,
          error: {
            code: 'LIVENESS_FAILURE',
            message: `Object ${objectId} did not respond to ${maxFailures} consecutive pings`,
          },
        }));
    } catch {
      // best effort
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
   * Trigger renegotiation for a connection via message passing.
   */
  private async triggerRenegotiation(
    agreementId: AgreementId,
    errorContext: string
  ): Promise<boolean> {
    if (!this.negotiatorId) {
      log.error('No negotiator set, cannot renegotiate');
      return false;
    }

    log.info(`Triggering renegotiation for ${agreementId}`);

    // Notify listeners
    this.send(
      event(
        this.id,
        this.id, // Self-notification for logging
        'renegotiationTriggered',
        agreementId
      )
    );

    try {
      const result = await this.request<{ success: boolean }>(
        request(this.id, this.negotiatorId, 'renegotiate', {
          agreementId,
          errorContext,
        })
      );
      return result.success;
    } catch (err) {
      log.error('Renegotiation failed:', err);
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
   * Get monitored object count.
   */
  get monitoredObjectCount(): number {
    return this.monitoredObjects.size;
  }

  /**
   * Clear all health data.
   */
  clear(): void {
    this.health.clear();
  }

  protected override getSourceForAsk(): string | undefined {
    return `## HealthMonitor Usage Guide

### Monitor an object's liveness

  await this.call(this.dep('HealthMonitor'), 'monitorObject',
    { objectId: targetId });

HealthMonitor pings monitored objects periodically. After ${this.config.maxPingFailures} consecutive failures, it emits an 'objectDead' event and notifies the Supervisor to restart the object.

### Check object liveness

  const status = await this.call(this.dep('HealthMonitor'), 'getObjectLiveness',
    { objectId: targetId });
  // status: { objectId, alive, consecutiveFailures, lastPingAt, lastSuccessAt }

### Track connection health

  await this.call(this.dep('HealthMonitor'), 'trackConnection',
    { agreementId: 'agreement-id' });

### Get health status

  const allStatus = await this.call(this.dep('HealthMonitor'), 'getAllStatus', {});
  const allLiveness = await this.call(this.dep('HealthMonitor'), 'getAllObjectLiveness', {});

### Stop monitoring

  await this.call(this.dep('HealthMonitor'), 'unmonitorObject',
    { objectId: targetId });

### Start/stop the periodic check cycle

  await this.call(this.dep('HealthMonitor'), 'startMonitoring', {});

### Connection health details

  const status = await this.call(this.dep('HealthMonitor'), 'getStatus',
    { agreementId: 'agreement-id' });
  // status: { totalMessages, errors, errorRate, isHealthy, lastActivity }

### Force renegotiation

  await this.call(this.dep('HealthMonitor'), 'forceRenegotiate',
    { agreementId: 'agreement-id' });

### Manual health recording

  await this.call(this.dep('HealthMonitor'), 'recordSuccess', { agreementId: 'agreement-id' });
  await this.call(this.dep('HealthMonitor'), 'recordError', { agreementId: 'agreement-id' });

### Mark object ready after restart

  await this.call(this.dep('HealthMonitor'), 'markObjectReady', { objectId: targetId });
  // Resets ping failure count so the monitor gives the object a fresh chance

### Events
- healthWarning: connection error rate exceeded ${this.config.errorThreshold}%
- renegotiationTriggered: automatic renegotiation started
- objectDead: monitored object stopped responding to pings`;
  }

  protected override async onStop(): Promise<void> {
    this.stopMonitoring();
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
