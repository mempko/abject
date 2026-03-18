/**
 * Node.js worker_threads entry point for Abject parallelism.
 *
 * Same logic as abject-worker.ts but uses worker_threads.parentPort
 * instead of the Web Worker self API.
 */

import { parentPort } from 'node:worker_threads';
import * as path from 'node:path';
import { AbjectId } from '../src/core/types.js';
import { Abject } from '../src/core/abject.js';
import { WorkerBus } from '../src/runtime/worker-bus.js';
import type { WorkerInboundMessage } from '../src/runtime/worker-bridge.js';

// Worker-eligible constructor imports
import { LLMObject } from '../src/objects/llm-object.js';
import { ObjectCreator } from '../src/objects/object-creator.js';
import { ProxyGenerator } from '../src/objects/proxy-generator.js';
import { Negotiator } from '../src/protocol/negotiator.js';
import { HealthMonitor } from '../src/protocol/health-monitor.js';
import { HttpClient } from '../src/objects/capabilities/http-client.js';
import { Timer } from '../src/objects/capabilities/timer.js';
import { Clipboard } from '../src/objects/capabilities/clipboard.js';
import { Console } from '../src/objects/capabilities/console.js';
import { FileSystem } from '../src/objects/capabilities/filesystem.js';
import { AbjectEditor } from '../src/objects/abject-editor.js';
import { JobManager } from '../src/objects/job-manager.js';
import { GoalManager } from '../src/objects/goal-manager.js';
import { GoalBrowser } from '../src/objects/goal-browser.js';
import { AbjectStore } from '../src/objects/abject-store.js';
import { Settings } from '../src/objects/settings.js';
import { AppExplorer } from '../src/objects/app-explorer.js';
import { ObjectBrowser } from '../src/objects/object-browser.js';
import { JobBrowser } from '../src/objects/job-browser.js';
import { Chat } from '../src/objects/chat.js';
import { ThemeAbject } from '../src/objects/theme.js';
import { Taskbar } from '../src/objects/taskbar.js';
import { ProcessExplorer } from '../src/objects/process-explorer.js';
import { GlobalSettings } from '../src/objects/global-settings.js';
import { PeerNetwork } from '../src/objects/peer-network.js';
import { ScriptableAbject } from '../src/objects/scriptable-abject.js';
import { NodeStorage } from '../server/node-storage.js';

if (!parentPort) {
  throw new Error('abject-worker-node.ts must be run inside a worker_threads Worker');
}

const port = parentPort;

// Constructor registry — same constructors as server/index.ts, minus DOM objects
type ObjectFactory = (args?: unknown) => Abject;

const constructors = new Map<string, ObjectFactory>();
constructors.set('LLMObject', () => new LLMObject());
constructors.set('HttpClient', () => new HttpClient());
constructors.set('Storage', (args?: unknown) => {
  const opts = args as { dbName?: string } | undefined;
  if (opts?.dbName) {
    const wsId = opts.dbName.replace('abjects-storage-', '');
    const storagePath = path.join(process.cwd(), '.abjects', `ws-${wsId}`, 'storage.json');
    return new NodeStorage(storagePath);
  }
  return new NodeStorage();
});
constructors.set('Timer', () => new Timer());
constructors.set('Clipboard', () => new Clipboard());
constructors.set('Console', () => new Console());
constructors.set('FileSystem', () => new FileSystem());
constructors.set('ProxyGenerator', () => new ProxyGenerator());
constructors.set('Negotiator', () => new Negotiator());
constructors.set('HealthMonitor', () => new HealthMonitor());
constructors.set('ObjectCreator', () => new ObjectCreator());
constructors.set('AbjectEditor', () => new AbjectEditor());
constructors.set('Settings', () => new Settings());
constructors.set('AppExplorer', () => new AppExplorer());
constructors.set('ObjectBrowser', () => new ObjectBrowser());
constructors.set('JobManager', () => new JobManager());
constructors.set('JobBrowser', () => new JobBrowser());
constructors.set('GoalManager', () => new GoalManager());
constructors.set('GoalBrowser', () => new GoalBrowser());
constructors.set('Chat', () => new Chat());
constructors.set('AbjectStore', () => new AbjectStore());
constructors.set('Theme', () => new ThemeAbject());
constructors.set('Taskbar', () => new Taskbar());
constructors.set('ProcessExplorer', () => new ProcessExplorer());
constructors.set('GlobalSettings', () => new GlobalSettings());
constructors.set('PeerNetwork', () => new PeerNetwork());
constructors.set('ScriptableAbject', (args?: unknown) => {
  const opts = args as { manifest: import('../src/core/types.js').AbjectManifest; source: string; owner: string };
  return new ScriptableAbject(opts.manifest, opts.source, opts.owner as import('../src/core/types.js').AbjectId);
});

// Worker state — pass parentPort.postMessage so WorkerBus routes via worker_threads
const workerBus = new WorkerBus((data) => port.postMessage(data));
const objects = new Map<AbjectId, Abject>();

/**
 * Spawn an object inside this worker.
 */
async function spawnObject(
  objectId: AbjectId,
  constructorName: string,
  constructorArgs?: unknown,
  registryId?: AbjectId,
  parentId?: AbjectId,
): Promise<void> {
  const factory = constructors.get(constructorName);
  if (!factory) {
    port.postMessage({
      type: 'error',
      objectId,
      error: `No constructor for '${constructorName}' in worker`,
    });
    return;
  }

  try {
    const obj = factory(constructorArgs);
    obj.setId(objectId);

    // Pre-seed registry hint so the object can discover dependencies
    if (registryId) {
      obj.setRegistryHint(registryId);
    }

    await obj.init(workerBus, parentId);
    objects.set(objectId, obj);

    port.postMessage({ type: 'spawned', objectId });
  } catch (err) {
    port.postMessage({
      type: 'error',
      objectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Kill an object inside this worker.
 */
async function killObject(objectId: AbjectId): Promise<void> {
  const obj = objects.get(objectId);
  if (obj) {
    try {
      await obj.stop();
    } catch {
      // Object may already be stopped
    }
    objects.delete(objectId);
  }
  port.postMessage({ type: 'stopped', objectId });
}

// Handle messages from the main thread
port.on('message', async (data: WorkerInboundMessage) => {
  const { type } = data;

  switch (type) {
    case 'spawn': {
      const { objectId, constructorName, constructorArgs, registryId, parentId } = data;
      await spawnObject(objectId!, constructorName!, constructorArgs, registryId, parentId);
      break;
    }

    case 'kill': {
      const { objectId } = data;
      await killObject(objectId!);
      break;
    }

    case 'bus:deliver': {
      // Main thread routing a message to a local object
      const { message } = data;
      if (message) {
        workerBus.deliverFromMain(message);
      }
      break;
    }

    case 'bus:reply': {
      // Main thread routing a reply to a local object via fast-path
      const { message } = data;
      if (message) {
        workerBus.deliverReplyFromMain(message);
      }
      break;
    }

    case 'peer:port': {
      // Direct MessagePort from a peer worker — transferred in the message data
      const { workerIndex } = data;
      const peerPort = (data as { port?: import('node:worker_threads').MessagePort }).port;
      if (peerPort && workerIndex !== undefined) {
        workerBus.addPeerPort(workerIndex, peerPort as unknown as MessagePort);
      }
      break;
    }

    case 'peer:place': {
      const { objectId, workerIndex } = data;
      if (objectId && workerIndex !== undefined) {
        workerBus.addPeerObject(objectId, workerIndex);
      }
      break;
    }

    case 'peer:remove': {
      const { objectId } = data;
      if (objectId) {
        workerBus.removePeerObject(objectId);
      }
      break;
    }

    default:
      console.warn(`[AbjectWorker:Node] Unknown message type: ${type}`);
  }
});

// Signal ready
port.postMessage({ type: 'ready' });
