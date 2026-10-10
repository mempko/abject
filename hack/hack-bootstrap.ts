/**
 * hack-bootstrap.ts - boots a real Abjects backend for the security audit.
 *
 * Runs the headless edition's own bootstrap (`bootServer` in
 * server/boot.ts), so the audit attacks what ships: SettingsManager,
 * PermissionBroker, AuthGate and DialogBroker, the package ingest (and with
 * it the native KnowledgeBase), the worker pool and the dedicated P2P
 * worker. There is no second copy of the spawn order here to drift.
 *
 * boot.ts reads its configuration from the environment when it loads, so the
 * orchestrator (security-audit.ts) sets it per process: WS_PORT, CLI_PORT and
 * HTTP_PORT (one set per instance), ABJECTS_DATA_DIR, and
 * ABJECTS_SIGNALING_URLS, which pins signaling to the local test server so
 * neither instance dials the public default.
 *
 * Once boot returns, this registers its own sender on the main bus and finds
 * the objects the audit drives through the Registry, by name.
 */

import type { AbjectId, AbjectMessage, ObjectRegistration } from '../src/core/types.js';
import { getRuntime, type Runtime } from '../src/runtime/runtime.js';
import type { MessageBus } from '../src/runtime/message-bus.js';
import * as message from '../src/core/message.js';
import * as server from '../server/boot.js';

export interface BootResult {
  runtime: Runtime;
  bus: MessageBus;
  registryId: AbjectId;
  workspaceManagerId: AbjectId;
  workspaceShareRegistryId: AbjectId;
  peerRegistryId: AbjectId;
  peerRouterId: AbjectId;
  identityId: AbjectId;
  /** The global (system) Storage, not a workspace's. */
  storageId: AbjectId;
  peerId: string;
  bootstrapRequest: <T>(target: AbjectId, method: string, payload: unknown) => Promise<T>;
  /** Release the backend the way a SIGTERM does, then exit. */
  shutdown: () => Promise<never>;
}

const SENDER_ID = 'hack-bootstrap' as AbjectId;
const REQUEST_TIMEOUT_MS = 30_000;

export async function bootAbjectsCore(): Promise<BootResult> {
  if (!process.env.ABJECTS_SIGNALING_URLS) {
    throw new Error('ABJECTS_SIGNALING_URLS must name the audit\'s signaling server (security-audit.ts sets it)');
  }

  await server.bootServer({
    edition: 'headless',
    workerScript: new URL('../workers/abject-worker-headless.ts', import.meta.url),
    p2pWorkerScript: new URL('../workers/p2p-worker-headless.ts', import.meta.url),
  });

  const runtime = getRuntime();
  const bus = runtime.messageBus;
  const registryId = runtime.objectRegistry.id;

  // The bootstrap's own sender is gone once boot returns; this one stays for
  // the life of the process.
  const pending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const mailbox = bus.register(SENDER_ID);
  void (async () => {
    for (;;) {
      let msg: AbjectMessage;
      try { msg = await mailbox.receive(); } catch { break; }
      const entry = pending.get(msg.header.correlationId!);
      if (!entry) continue;
      pending.delete(msg.header.correlationId!);
      clearTimeout(entry.timer);
      if (msg.header.type === 'error') {
        entry.reject(new Error((msg.payload as { message: string }).message));
      } else {
        entry.resolve(msg.payload);
      }
    }
  })();

  function bootstrapRequest<T>(target: AbjectId, method: string, payload: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const msg = message.request(SENDER_ID, target, method, payload);
      const timer = setTimeout(() => {
        pending.delete(msg.header.messageId);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(msg.header.messageId, { resolve: resolve as (v: unknown) => void, reject, timer });
      try { bus.send(msg); } catch (err) {
        clearTimeout(timer);
        pending.delete(msg.header.messageId);
        reject(err as Error);
      }
    });
  }

  /** The one object of this name in the global Registry. */
  async function find(name: string): Promise<AbjectId> {
    const found = await bootstrapRequest<ObjectRegistration[]>(registryId, 'discover', { name });
    if (found.length !== 1) {
      throw new Error(`expected one '${name}' in the global registry, found ${found.length}`);
    }
    return found[0].id;
  }

  const [
    workspaceManagerId, workspaceShareRegistryId, peerRegistryId, peerRouterId, identityId, storageId,
  ] = await Promise.all([
    find('WorkspaceManager'), find('WorkspaceShareRegistry'), find('PeerRegistry'),
    find('PeerRouter'), find('Identity'), find('Storage'),
  ]);
  const { peerId } = await bootstrapRequest<{ peerId: string }>(identityId, 'getIdentity', {});

  async function shutdown(): Promise<never> {
    try {
      await server.backendShutdown?.();
    } finally {
      process.exit(0);
    }
  }

  return {
    runtime,
    bus,
    registryId,
    workspaceManagerId,
    workspaceShareRegistryId,
    peerRegistryId,
    peerRouterId,
    identityId,
    storageId,
    peerId,
    bootstrapRequest,
    shutdown,
  };
}
