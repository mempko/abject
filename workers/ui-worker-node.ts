/**
 * Dedicated UI Worker — runs BackendUI in a separate worker_thread.
 *
 * Protocol:
 *   1. Main thread sends { type: 'init-config', config: { backendUIId } }
 *   2. Main thread sends { type: 'port-transfer', portName: 'ws-relay', port: MessagePort }
 *   3. Worker creates BackendUI, inits it on WorkerBus
 *   4. Worker creates MessagePortUITransport from the received port
 *   5. Worker posts { type: 'ready' }
 *
 * After ready:
 *   - Abject messages are routed via WorkerBus ↔ main bus (standard bus:deliver/bus:reply)
 *   - Frontend WS data is relayed via the MessagePort (main thread relays ws ↔ port)
 */

import { parentPort } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { AbjectId } from '../src/core/types.js';
import { WorkerBus } from '../src/runtime/worker-bus.js';
import type { WorkerInboundMessage } from '../src/runtime/worker-bridge.js';
import { BackendUI } from '../server/backend-ui.js';
import { MessagePortUITransport } from '../server/ui-transport.js';
import { Log } from '../src/core/timed-log.js';

if (!parentPort) {
  throw new Error('ui-worker-node.ts must be run inside a worker_threads Worker');
}

const port = parentPort;
const log = new Log('UIWorker');

// Worker state
const workerBus = new WorkerBus((data) => port.postMessage(data));
let backendUI: BackendUI | null = null;
let backendUIId: AbjectId | null = null;

/**
 * Handle messages from the main thread.
 */
port.on('message', async (data: { type: string; [key: string]: unknown }) => {
  const { type } = data;

  switch (type) {
    case 'init-config': {
      const config = data.config as { backendUIId: string; registryId?: string };
      backendUIId = config.backendUIId as AbjectId;
      log.info(`Received config: backendUIId=${backendUIId.slice(0, 8)}`);

      // Create BackendUI with the pre-assigned ID
      backendUI = new BackendUI();
      backendUI.setId(backendUIId);
      if (config.registryId) {
        backendUI.setRegistryHint(config.registryId as AbjectId);
      }
      await backendUI.init(workerBus);
      log.info('BackendUI initialized on WorkerBus');
      break;
    }

    case 'port-transfer': {
      const portName = data.portName as string;
      const wsPort = data.port as MessagePort;

      if (portName === 'ws-relay' && backendUI) {
        const transport = new MessagePortUITransport(wsPort);
        backendUI.setTransport(transport);
        log.info('WebSocket relay port connected to BackendUI');
      } else if (portName === 'ws-relay') {
        log.warn('Received ws-relay port but BackendUI not yet initialized');
      }
      break;
    }

    case 'set-auth-gate': {
      // Auth config is managed on the main thread; BackendUI just gets the reference
      // For the worker, auth-gate updates come as explicit messages
      if (backendUI) {
        const typed = data as unknown as {
          authConfig: import('../server/auth.js').AuthConfig;
          sessionStore: import('../server/auth.js').SessionStore;
        };
        backendUI.setAuthGate(typed.authConfig, typed.sessionStore);
      }
      break;
    }

    // Standard WorkerBridge protocol messages
    case 'bus:deliver': {
      const msg = (data as WorkerInboundMessage).message;
      if (msg) {
        workerBus.deliverFromMain(msg);
      }
      break;
    }

    case 'bus:reply': {
      const msg = (data as WorkerInboundMessage).message;
      if (msg) {
        workerBus.deliverReplyFromMain(msg);
      }
      break;
    }

    default:
      log.warn(`Unknown message type: ${type}`);
  }
});

// Signal ready
port.postMessage({ type: 'ready' });
log.info('UI Worker started, waiting for init-config...');
