/**
 * hack-victim.ts — Victim server for P2P security audit.
 *
 * Boots a full Abjects instance, creates 3 workspaces with different access modes,
 * stores a secret flag in the local workspace, connects to signaling, and waits.
 */

import { bootAbjectsCore } from './hack-bootstrap.js';
import type { AbjectId } from '../src/core/types.js';

const SIGNALING_URL = 'ws://localhost:7730';
const SECRET_FLAG = 'SECRET_FLAG{p2p_audit_2026}';

async function main(): Promise<void> {
  console.log('[VICTIM] Booting...');
  const boot = await bootAbjectsCore({ dataDir: '.abjects-hack-victim', signalingUrl: SIGNALING_URL });
  const { bootstrapRequest, workspaceManagerId, peerRegistryId, storageId, peerId } = boot;

  console.log(`[VICTIM] PeerId: ${peerId.slice(0, 16)}...`);

  // Get the default workspace (created during boot)
  const workspaces = await bootstrapRequest<Array<{ id: string; name: string }>>(
    workspaceManagerId, 'listWorkspaces', {},
  );
  const defaultWs = workspaces[0];
  console.log(`[VICTIM] Default workspace: ${defaultWs.name} (${defaultWs.id})`);

  // Create Public Zone workspace
  const { workspaceId: publicWsId } = await bootstrapRequest<{ workspaceId: string }>(
    workspaceManagerId, 'createWorkspace', { name: 'Public Zone' },
  );
  await bootstrapRequest(workspaceManagerId, 'setAccessMode', {
    workspaceId: publicWsId, accessMode: 'public',
  });

  // Create Private Zone workspace (whitelist = [] → nobody allowed)
  const { workspaceId: privateWsId } = await bootstrapRequest<{ workspaceId: string }>(
    workspaceManagerId, 'createWorkspace', { name: 'Private Zone' },
  );
  await bootstrapRequest(workspaceManagerId, 'setAccessMode', {
    workspaceId: privateWsId, accessMode: 'private',
  });
  // Whitelist is empty by default — nobody can access

  // Default workspace stays 'local' (the default)
  const localWsId = defaultWs.id;

  // Store secret flag in global (system) Storage
  await bootstrapRequest(storageId, 'set', {
    key: 'secret', value: SECRET_FLAG,
  });

  // Get workspace details for IPC
  const detailed = await bootstrapRequest<Array<{
    workspaceId: string;
    name: string;
    accessMode: string;
    childIds: string[];
    registryId: string;
    exposedObjectIds: string[];
  }>>(workspaceManagerId, 'listWorkspacesDetailed', {});

  const wsInfo: Record<string, { workspaceId: string; registryId: string; childIds: string[]; exposedObjectIds: string[] }> = {};
  for (const ws of detailed) {
    if (ws.workspaceId === publicWsId) wsInfo['public'] = ws;
    else if (ws.workspaceId === privateWsId) wsInfo['private'] = ws;
    else if (ws.workspaceId === localWsId) wsInfo['local'] = ws;
  }

  // Connect to signaling server
  console.log('[VICTIM] Connecting to signaling...');
  await bootstrapRequest(peerRegistryId, 'connectSignaling', { url: SIGNALING_URL });

  // Wait for signaling to register
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Send ready message to parent via IPC
  process.send!({
    type: 'ready',
    peerId,
    storageId,
    workspaces: wsInfo,
    workspaceManagerId,
    peerRouterId: boot.peerRouterId,
    workspaceShareRegistryId: boot.workspaceShareRegistryId,
  });

  console.log('[VICTIM] Ready. Waiting for shutdown...');

  // Wait for shutdown IPC
  process.on('message', (msg: { type: string }) => {
    if (msg.type === 'shutdown') {
      console.log('[VICTIM] Shutting down...');
      boot.runtime.stop().then(() => process.exit(0));
    }
  });
}

main().catch((err) => {
  console.error('[VICTIM] Fatal:', err);
  process.exit(1);
});
