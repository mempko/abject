/**
 * DedicatedWorkerBridge — extends WorkerBridge for dedicated workers
 * (UI, P2P) that need custom init and bidirectional non-Abject messages.
 *
 * Standard Abject message routing (bus:deliver, bus:send)
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
 * How long to let a confirmed worker's loop turn before destroying its env.
 * Short on purpose: it is slack for an in-flight callback, not a drain.
 */
const TERMINATE_GRACE_MS = 150;

/** What a worker reports back when asked to shut down. */
export interface WorkerShutdownResult {
  /** The worker answered before the deadline — its objects really did stop. */
  confirmed: boolean;
  /**
   * The worker shut libdatachannel down in its own env. The main thread must
   * then leave it alone: calling cleanup() again from an env that never owned
   * a PeerConnection drains nothing and only loads the addon somewhere new.
   */
  nativeCleanup: boolean;
}

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

  /** Dedicated workers apply no proxy routes of their own: the main bus does. */
  protected override forwardToBus(message: AbjectMessage): void {
    this.bus.send(message);
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
   * Stop the worker's objects, then terminate the thread.
   *
   * Terminating alone is not enough and stopping alone is not enough. The
   * objects a dedicated worker builds — PeerRegistry above all — own things
   * the process cannot exit while holding: live PeerConnections, a signaling
   * socket, an auto-connect loop that keeps dialing. Only their own onStop()
   * closes those, and nothing else in the shutdown path ever reaches them,
   * so we ask the worker to run it and wait for the confirmation. The
   * terminate() afterwards is what guarantees the thread cannot mint a new
   * connection while the main thread is inside libdatachannel's cleanup.
   *
   * The wait is bounded: a worker too wedged to answer still gets terminated.
   */
  async shutdownWorker(timeoutMs = 3000): Promise<WorkerShutdownResult> {
    if (this.isDead) {
      log.warn('worker was already dead before shutdown — its objects never stopped');
      return { confirmed: false, nativeCleanup: false };
    }
    const startedAt = Date.now();
    let result: WorkerShutdownResult = { confirmed: false, nativeCleanup: false };
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const confirmed = new Promise<WorkerShutdownResult>((resolve) => {
        this.onCustom('shutdown-complete', (data) => resolve({
          confirmed: true,
          nativeCleanup: data.nativeCleanup === true,
        }));
        timer = setTimeout(() => resolve({ confirmed: false, nativeCleanup: false }), timeoutMs);
      });
      this.sendCustom({ type: 'shutdown' });
      result = await confirmed;
      if (timer) clearTimeout(timer);
      if (result.confirmed) {
        const native = result.nativeCleanup ? ', libdatachannel shut down in-worker' : '';
        log.info(`worker confirmed shutdown in ${Date.now() - startedAt}ms${native}`);
        // A confirmed worker is still holding a live event loop for a moment.
        // Terminating destroys its env, and anything already queued on that
        // loop then has nowhere to land — which is exactly how a native
        // callback aborted the process with `Error::Error
        // napi_define_properties` under `Worker::Run`. Joining the RTC threads
        // inside the worker is what actually removes those callers; this is
        // just a turn or two of slack for whatever was already in flight when
        // it answered.
        await new Promise((r) => setTimeout(r, TERMINATE_GRACE_MS));
      } else {
        log.warn(`worker did not confirm shutdown within ${timeoutMs}ms — terminating anyway`);
      }
    } catch (err) {
      log.warn('worker shutdown request failed, terminating anyway:', err);
    } finally {
      this.terminate();
    }
    return result;
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
