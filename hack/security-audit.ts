/**
 * security-audit.ts — Orchestrator for P2P security audit.
 *
 * Starts a signaling server + two full Abjects processes (victim and attacker),
 * coordinates via IPC, and prints a formatted security audit report.
 *
 * Usage: pnpm hack
 *
 * Every port comes from one base, WS_PORT (default 7730): the signaling
 * server listens on the base, the victim takes base+1 and the attacker
 * base+11 as their own WS_PORT (each also binds WS_PORT+4 for the CLI gateway
 * and WS_PORT+5 for the HTTP gateway). The two data directories go under
 * ABJECTS_DATA_DIR when it is set, else in the working directory.
 */

import { fork, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SignalingServer } from '../server/signaling-server.js';

const BASE_PORT = parseInt(process.env.WS_PORT ?? '7730', 10);
const SIGNALING_PORT = BASE_PORT;
const VICTIM_PORT = BASE_PORT + 1;
const ATTACKER_PORT = BASE_PORT + 11;
const SIGNALING_URL = `ws://localhost:${SIGNALING_PORT}`;
const DATA_ROOT = process.env.ABJECTS_DATA_DIR ? path.resolve(process.env.ABJECTS_DATA_DIR) : process.cwd();
const VICTIM_DATA = path.join(DATA_ROOT, process.env.ABJECTS_DATA_DIR ? 'hack-victim' : '.abjects-hack-victim');
const ATTACKER_DATA = path.join(DATA_ROOT, process.env.ABJECTS_DATA_DIR ? 'hack-attacker' : '.abjects-hack-attacker');
// Two full backends boot one after the other before the attacks start.
const TIMEOUT_MS = 180_000;

/** The environment for one instance: its own ports, data and the local signaling server. */
function instanceEnv(wsPort: number, dataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    WS_PORT: String(wsPort),
    CLI_PORT: String(wsPort + 4),
    HTTP_PORT: String(wsPort + 5),
    ABJECTS_DATA_DIR: dataDir,
    ABJECTS_SIGNALING_URLS: SIGNALING_URL,
  };
}

/** Ask a child to shut down, and SIGKILL it if it has not left in time. */
async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  if (child.connected) child.send({ type: 'shutdown' });
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 8000); })]);
  clearTimeout(timer);
  child.kill('SIGKILL');
}

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

function cleanDataDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`  Cleaned ${dir}`);
  }
}

function printReport(attacks: AttackResult[]): void {
  const phases = [
    { num: 0, name: 'Signaling' },
    { num: 1, name: 'Reconnaissance' },
    { num: 2, name: 'Enumeration' },
    { num: 3, name: 'Exploitation' },
    { num: 4, name: 'Exfiltration' },
  ];

  const passed = attacks.filter(a => a.status === 'PASS').length;
  const vulns = attacks.filter(a => a.status === 'VULN').length;
  const infos = attacks.filter(a => a.status === 'INFO').length;
  const fails = attacks.filter(a => a.status === 'FAIL').length;

  console.log('');
  console.log('==========================================');
  console.log('  ABJECTS P2P SECURITY AUDIT REPORT');
  console.log('==========================================');
  console.log('');

  for (const phase of phases) {
    const phaseAttacks = attacks.filter(a => a.phase === phase.num);
    if (phaseAttacks.length === 0) continue;

    console.log(`Phase ${phase.num} — ${phase.name}`);
    for (const attack of phaseAttacks) {
      const icon = attack.status === 'VULN' ? '\x1b[31m[VULN]\x1b[0m'
        : attack.status === 'PASS' ? '\x1b[32m[PASS]\x1b[0m'
        : attack.status === 'INFO' ? '\x1b[36m[INFO]\x1b[0m'
        : '\x1b[33m[FAIL]\x1b[0m';
      console.log(`  ${icon} ${attack.id} ${attack.name}: ${attack.actual}`);
      if (attack.details) {
        console.log(`         ${attack.details}`);
      }
    }
    console.log('');
  }

  console.log('SUMMARY');
  console.log(`  Passed: ${passed}  |  Vulnerabilities: ${vulns}  |  Info: ${infos}  |  Errors: ${fails}`);

  // Print critical findings
  const criticals = attacks.filter(a => a.status === 'VULN');
  if (criticals.length > 0) {
    console.log('');
    console.log('  \x1b[31mCritical findings:\x1b[0m');
    for (const c of criticals) {
      console.log(`    - ${c.id} ${c.name}: ${c.actual}`);
    }
  }

  console.log('==========================================');
  console.log('');
}

async function main(): Promise<void> {
  console.log('==========================================');
  console.log('  ABJECTS P2P SECURITY AUDIT');
  console.log('==========================================');
  console.log('');

  // Clean up old data dirs
  console.log('Cleaning up...');
  cleanDataDir(VICTIM_DATA);
  cleanDataDir(ATTACKER_DATA);

  // Start signaling server in-process
  console.log(`Starting signaling server on port ${SIGNALING_PORT}...`);
  const signalingServer = new SignalingServer(SIGNALING_PORT);

  let victim: ChildProcess | undefined;
  let attacker: ChildProcess | undefined;

  const cleanup = async () => {
    await Promise.all([stopChild(attacker), stopChild(victim)]);
    await signalingServer.close();

    // Clean data dirs
    cleanDataDir(VICTIM_DATA);
    cleanDataDir(ATTACKER_DATA);
  };

  // Global timeout
  const timeout = setTimeout(async () => {
    console.error('\n[AUDIT] TIMEOUT — audit took too long');
    await cleanup();
    process.exit(1);
  }, TIMEOUT_MS);

  try {
    // Fork victim process
    console.log('Starting victim server...');
    victim = fork(
      new URL('./hack-victim.ts', import.meta.url).pathname,
      [],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: instanceEnv(VICTIM_PORT, VICTIM_DATA),
      },
    );

    // Pipe victim output with prefix
    victim.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        console.log(`  [V] ${line}`);
      }
    });
    victim.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        console.log(`  [V!] ${line}`);
      }
    });

    // Wait for victim ready
    console.log('Waiting for victim to be ready...');
    const victimInfo = await new Promise<{
      peerId: string;
      storageId: string;
      workspaces: Record<string, unknown>;
      workspaceManagerId: string;
      peerRouterId: string;
      workspaceShareRegistryId: string;
    }>((resolve, reject) => {
      victim!.on('message', (msg: unknown) => {
        const m = msg as { type: string; [key: string]: unknown };
        if (m.type === 'ready') {
          resolve(m as unknown as typeof victimInfo);
        }
      });
      victim!.on('exit', (code) => {
        reject(new Error(`Victim exited with code ${code}`));
      });
    });
    console.log(`Victim ready! PeerId: ${victimInfo.peerId.slice(0, 16)}...`);

    // Fork attacker process
    console.log('Starting attacker...');
    attacker = fork(
      new URL('./hack-attacker.ts', import.meta.url).pathname,
      [],
      {
        execArgv: ['--import', 'tsx'],
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: instanceEnv(ATTACKER_PORT, ATTACKER_DATA),
      },
    );

    // Pipe attacker output with prefix
    attacker.stdout?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        console.log(`  [A] ${line}`);
      }
    });
    attacker.stderr?.on('data', (data: Buffer) => {
      for (const line of data.toString().split('\n').filter(Boolean)) {
        console.log(`  [A!] ${line}`);
      }
    });

    // Send victim info to attacker (spread first, then override type)
    attacker.send({ ...victimInfo, type: 'victimInfo' });

    // Wait for attacker results
    console.log('Waiting for attack results...');
    const attackResults = await new Promise<AttackResult[]>((resolve, reject) => {
      attacker!.on('message', (msg: { type: string; attacks?: AttackResult[] }) => {
        if (msg.type === 'results') {
          resolve(msg.attacks ?? []);
        }
      });
      attacker!.on('exit', (code) => {
        reject(new Error(`Attacker exited with code ${code}`));
      });
    });

    clearTimeout(timeout);

    // Print report
    printReport(attackResults);

    // Clean up
    await cleanup();

  } catch (err) {
    clearTimeout(timeout);
    console.error('[AUDIT] Error:', err);
    await cleanup();
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[AUDIT] Fatal:', err);
  process.exit(1);
});
