/**
 * DedicatedWorkerBridge — extends WorkerBridge for dedicated workers
 * (UI, P2P) that need custom init and bidirectional non-Abject messages.
 *
 * Standard Abject message routing (bus:deliver, bus:reply, bus:send)
 * is inherited from WorkerBridge. This class adds:
 *   - sendConfig() / transferPort() for worker initialization
 *   - sendCustom() for arbitrary main→worker messages
 *   - onCustom() for arbitrary worker→main messages
 */

import { AbjectMessage } from '../core/types.js';
import { WorkerBridge } from './worker-bridge.js';
import type { WorkerLike } from './worker-bridge.js';
import type { MessageBus } from './message-bus.js';
import { Log } from '../core/timed-log.js';

const log = new Log('DedicatedWorkerBridge');

/**
 * Custom message from main thread → dedicated worker.
 */
export interface DedicatedInboundMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Custom message from dedicated worker → main thread.
 */
export interface DedicatedOutboundMessage {
  type: string;
  [key: string]: unknown;
}

/**
 * Bridge for dedicated workers that extends the standard WorkerBridge
 * protocol with custom message types for non-Abject communication.
 */
export class DedicatedWorkerBridge extends WorkerBridge {
  private customHandlers: Map<string, (data: DedicatedOutboundMessage) => void> = new Map();

  constructor(worker: WorkerLike, bus: MessageBus) {
    super(worker, bus);
  }

  /**
   * Send a configuration object to the worker during initialization.
   */
  sendConfig(config: Record<string, unknown>): void {
    this.worker.postMessage({ type: 'init-config', config });
  }

  /**
   * Transfer a MessagePort to the worker.
   * The port must be included in the data AND the transferList.
   */
  transferPort(portName: string, port: unknown): void {
    this.worker.postMessage(
      { type: 'port-transfer', portName, port },
      [port],
    );
  }

  /**
   * Send a custom (non-Abject) message to the worker.
   */
  sendCustom(msg: DedicatedInboundMessage): void {
    this.worker.postMessage(msg);
  }

  /**
   * Register a handler for a custom outbound message type from the worker.
   */
  onCustom(type: string, handler: (data: DedicatedOutboundMessage) => void): void {
    this.customHandlers.set(type, handler);
  }

  /**
   * Override to intercept custom message types before standard WorkerBridge handling.
   */
  protected override handleWorkerMessage(event: { data: unknown }): void {
    const data = event.data as { type: string; [key: string]: unknown };
    if (!data || typeof data.type !== 'string') {
      super.handleWorkerMessage(event);
      return;
    }

    const handler = this.customHandlers.get(data.type);
    if (handler) {
      handler(data as DedicatedOutboundMessage);
      return;
    }

    // Delegate to standard WorkerBridge protocol (ready, spawned, stopped, bus:send, error)
    super.handleWorkerMessage(event);
  }
}
