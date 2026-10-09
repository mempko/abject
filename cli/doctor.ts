/**
 * `abject doctor`: what is installed, what is running, and what is missing,
 * each line a check with what to do about it.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { liveInstance, readInstance, processAlive } from '../server/instance-file.js';
import { cliEdition, portOpen } from './locate.js';
import { installHome, logFilePath } from './backend.js';
import { serviceStatus } from './service.js';
import { connectClient } from './connect.js';
import { cliVersion } from './update.js';

type Result = 'ok' | 'warn' | 'fail';
const color = process.stdout.isTTY;
const mark: Record<Result, string> = color
  ? { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m!\x1b[0m', fail: '\x1b[31m✗\x1b[0m' }
  : { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };
const line = (result: Result, text: string, fix?: string): void => {
  process.stdout.write(`${mark[result]} ${text}\n`);
  if (fix) process.stdout.write(`    ${fix}\n`);
};

function onPath(program: string): boolean {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [program], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(dataDir: string): Promise<void> {
  const edition = cliEdition();
  line('ok', `abject ${cliVersion()} (${edition} edition)${installHome() ? `, installed in ${installHome()}` : ''}`);
  const [major, minor] = process.versions.node.split('.').map(Number);
  line(major > 22 || (major === 22 && minor >= 5) ? 'ok' : 'fail', `runtime Node ${process.versions.node}`,
    major > 22 || (major === 22 && minor >= 5) ? undefined : 'Abject needs Node 22.5 or newer (node:sqlite).');

  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.accessSync(dataDir, fs.constants.W_OK);
    line('ok', `data directory ${dataDir}`);
  } catch {
    line('fail', `data directory ${dataDir} is not writable`, 'Point ABJECTS_DATA_DIR at a folder you own.');
  }

  const record = readInstance(dataDir);
  const live = await liveInstance(dataDir);
  if (live) {
    line('ok', `backend running: ${live.edition} ${live.version}, pid ${live.pid}, gateway ws://127.0.0.1:${live.cliPort}`);
    try {
      const client = await connectClient({ url: `ws://127.0.0.1:${live.cliPort}`, ownerToken: live.ownerToken });
      const configured = await client.isConfigured().catch(() => undefined);
      line(configured ? 'ok' : 'warn', configured ? 'an AI model is configured' : 'no AI model is configured', configured ? undefined : 'Run `abject setup`.');
      const open = await client.listDialogs().catch(() => []);
      if (open.length > 0) line('warn', `${open.length} question${open.length === 1 ? '' : 's'} waiting on you`, 'Answer them in `abject` (/questions).');
      client.close();
    } catch (err) {
      line('fail', `the gateway did not accept a connection: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (record && processAlive(record.pid)) {
    line('warn', `backend pid ${record.pid} is alive but not answering its health check`, `See ${logFilePath(dataDir)}; \`abject stop\` clears it.`);
  } else {
    line('warn', 'no backend is running on this data directory',
      edition === 'desktop' ? 'Start the Abject app.' : 'Run `abject` or `abject start`.');
    const wsPort = Number(process.env.WS_PORT ?? 7719);
    const cliPort = Number(process.env.CLI_PORT ?? wsPort + 4);
    for (const port of [wsPort, cliPort]) {
      if (await portOpen(port)) line('warn', `port ${port} is taken by something else`, 'Another Abject (on a different data directory) or another program holds it; set WS_PORT to move this one.');
    }
  }

  if (edition === 'headless') {
    const status = serviceStatus();
    line(status.installed ? 'ok' : 'warn', `start at login: ${status.detail}`, status.installed ? undefined : 'Optional: `abject service install`.');
    const browsers = path.join(dataDir, 'browsers');
    const haveBrowser = fs.existsSync(browsers) && fs.readdirSync(browsers).length > 0;
    line(haveBrowser ? 'ok' : 'warn', haveBrowser ? 'Chromium installed for web browsing' : 'no Chromium for web browsing', haveBrowser ? undefined : 'Optional: `abject setup` downloads it.');
  }
  const npx = onPath('npx');
  line(npx ? 'ok' : 'warn', npx ? 'npx found (MCP servers can start)' : 'npx not found', npx ? undefined : 'MCP servers that start with npx need Node and npm on PATH.');
}
