/**
 * Guided setup: `abject setup`, and on first run.
 *
 * Two halves. The local half runs before any backend exists (where the data
 * lives); everything else is asked of the running backend through the same
 * CLI gateway ops the TUI's /settings uses, so setup works the same against a
 * headless backend and a desktop app, and finishing it in either place counts
 * for both (the backend's `isConfigured` is the one answer).
 *
 * Every step can be skipped with Enter, and each says what it is for.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AbjectClient } from './client.js';
import { chooseLine, confirmLine, promptLine } from './connect.js';
import { saveCliConfig } from './config.js';
import { defaultDataDir } from '../server/data-dir.js';
import { installHome } from './backend.js';
import { cliEdition, dataDirInUse } from './locate.js';
import { installService, serviceStatus } from './service.js';

const say = (text = ''): void => { process.stdout.write(`${text}\n`); };
const heading = (text: string): void => { say(); say(`\x1b[1m${text}\x1b[0m`); };

interface Preset { name: string; builtin: boolean; preset: { routing: Record<string, { provider: string; model: string } | undefined> } }
interface SchemaField { key: string; label: string; type: string; description?: string }
interface SchemaSection { id: string; label: string; fields: SchemaField[] }

/**
 * Before the backend: where the data lives. Returns the data directory to use.
 * Only the headless edition asks; the desktop app chooses its own.
 */
export async function runLocalSetup(dataDir: string): Promise<string> {
  heading('Welcome to Abject');
  say('Abject runs a team of agents that work through messages between objects.');
  say('This sets it up in a few steps; press Enter to accept a default or skip.');

  heading('Where your data lives');
  if (dataDirInUse(dataDir)) {
    say(`Found existing Abject data in ${dataDir}.`);
    say('The terminal and the desktop app share it: the same workspaces either way.');
    return dataDir;
  }
  say(`Abject keeps workspaces, settings and keys in ${dataDir}.`);
  const answer = (await promptLine('Keep it there? Enter a different folder, or press Enter: ')).trim();
  if (!answer) return dataDir;
  const chosen = path.resolve(answer.replace(/^~(?=$|[\\/])/, process.env.HOME ?? process.env.USERPROFILE ?? '~'));
  fs.mkdirSync(chosen, { recursive: true });
  saveCliConfig({ dataDir: chosen === defaultDataDir() ? undefined : chosen });
  say(`Data will live in ${chosen}.`);
  return chosen;
}

/** Environment variable a provider's key is commonly kept in: <ID>_API_KEY. */
function envKeyFor(providerId: string): string {
  return `${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

/** The model step: pick a provider, give its key, route the tiers. */
async function setupModels(client: AbjectClient): Promise<void> {
  heading('AI models');
  const configured = await client.isConfigured().catch(() => false);
  if (configured && !(await confirmLine('A model is already set up. Choose again?', false))) return;

  const [schema, presets] = await Promise.all([
    client.request<SchemaSection[]>('getSettingsSchema'),
    client.request<Preset[]>('listPresets', {}, 60_000),
  ]);
  const ai = schema.find(s => s.id === 'ai');
  const recommended = presets.filter(p => p.builtin && / recommended$/.test(p.name));
  if (recommended.length === 0) {
    say('This backend offers no provider presets. Set models later with /settings in the chat.');
    return;
  }
  const providerOf = (p: Preset) => p.preset.routing.smart?.provider ?? Object.values(p.preset.routing).find(Boolean)?.provider ?? '';
  const labels = recommended.map(p => {
    const provider = providerOf(p);
    const hasKey = ai?.fields.some(f => f.key === `credentials.${provider}`);
    const envReady = !!process.env[envKeyFor(provider)];
    return `${p.name.replace(/ recommended$/, '')}${hasKey ? (envReady ? `  (key found in ${envKeyFor(provider)})` : '') : '  (no key needed)'}`;
  });
  const defaultIndex = Math.max(0, recommended.findIndex(p => !!process.env[envKeyFor(providerOf(p))]));
  const choice = await chooseLine('Which provider should the agents use?', [...labels, 'Skip for now'], defaultIndex);
  if (choice === recommended.length) {
    say('Skipped. The agents need a model to work: run `abject setup` when ready.');
    return;
  }
  const preset = recommended[choice];
  const provider = providerOf(preset);
  const field = ai?.fields.find(f => f.key === `credentials.${provider}`);

  if (field) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const fromEnv = process.env[envKeyFor(provider)];
      let value: string;
      if (fromEnv && attempt === 0 && await confirmLine(`Use the key in ${envKeyFor(provider)}?`, true)) {
        value = fromEnv;
      } else {
        const hint = field.description ? ` (${field.description})` : '';
        value = (await promptLine(`${field.label}${hint}: `, field.type === 'secret')).trim();
      }
      if (!value) { say('No key given; skipped.'); return; }
      try {
        await client.request('setSettings', { section: 'ai', values: { credentials: { [provider]: value } } }, 60_000);
        const models = await client.request<unknown[]>('listModels', { provider }, 60_000);
        say(`Key saved; ${models.length} model${models.length === 1 ? '' : 's'} available.`);
        break;
      } catch (err) {
        say(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m`);
        if (attempt === 2) return;
      }
    }
  }
  try {
    await client.request('applyPreset', { name: preset.name }, 60_000);
    say(`Every tier now routes through ${preset.name.replace(/ recommended$/, '')}.`);
  } catch (err) {
    say(`\x1b[31mCould not route the tiers: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
  }
}

/** The permission step: what happens when nothing decides, and folders to trust. */
async function setupPermissions(client: AbjectClient): Promise<void> {
  heading('Permissions');
  say('When an agent wants to run a command or touch files that no rule covers, Abject asks you.');
  say('Questions show up in this terminal (and on the desktop, when one is open) and wait for your answer.');
  const modes = [
    'Ask me (recommended)',
    'Allow without asking: for a trusted machine running unattended (dangerous commands still ask)',
    'Deny without asking: unattended, and nothing new runs',
  ];
  const current = await client.request<{ mode: string }>('getSettings', { section: 'permissions' }).catch(() => ({ mode: 'ask' }));
  const index = await chooseLine('What should happen to a request no rule covers?', modes, ['ask', 'allow', 'deny'].indexOf(current.mode));
  const mode = (['ask', 'allow', 'deny'] as const)[index];
  await client.request('setSettings', { section: 'permissions', values: { mode } }, 60_000);

  const paths = (await promptLine('Folders agents may read and write without asking (comma-separated, Enter for none): ')).trim();
  if (paths) {
    const allowedPaths = paths.split(',').map(p => path.resolve(p.trim())).filter(Boolean);
    const fsValues = await client.request<{ allowedPaths: string[] }>('getSettings', { section: 'filesystem' });
    const merged = [...new Set([...(fsValues.allowedPaths ?? []), ...allowedPaths])];
    await client.request('setSettings', { section: 'filesystem', values: { allowedPaths: merged } }, 60_000);
    say(`Allowed: ${merged.join(', ')}`);
  }
}

/** A login, for when the gateway is reached from other machines. */
async function setupLogin(client: AbjectClient): Promise<void> {
  heading('Login');
  say('This machine reaches Abject without a login. A login matters when terminals or the web');
  say('gateway connect from elsewhere (through an SSH tunnel or a proxy).');
  if (!(await confirmLine('Require a login for those?', false))) return;
  const username = (await promptLine('username: ')).trim();
  const password = await promptLine('password: ', true);
  if (!username || !password) { say('Skipped: both are needed.'); return; }
  await client.request('setSettings', { section: 'auth', values: { enabled: true, username, password } }, 60_000);
  say('Login required from now on; this machine still gets in through its owner token.');
}

/** Chromium for the web browsing agent, downloaded into the data directory. */
async function setupBrowser(dataDir: string): Promise<boolean> {
  heading('Web browsing');
  const browsers = path.join(dataDir, 'browsers');
  if (fs.existsSync(browsers) && fs.readdirSync(browsers).length > 0) {
    say('Chromium is installed for web browsing.');
    return false;
  }
  const home = installHome();
  const playwrightCli = home ? path.join(home, 'lib', 'node_modules', 'playwright', 'cli.js') : undefined;
  if (!playwrightCli || !fs.existsSync(playwrightCli)) {
    say('Web browsing needs Playwright and Chromium: `npx playwright install chromium`.');
    return false;
  }
  say('The web agent drives a real browser. It needs Chromium, about 150 MB.');
  if (!(await confirmLine('Download it now?', false))) return false;
  // The packaged binary runs scripts through its own entry; see sea-bootstrap.cjs.
  const sea = process.env.ABJECT_SEA === '1';
  const args = sea ? ['__abject-run', playwrightCli, 'install', 'chromium'] : [playwrightCli, 'install', 'chromium'];
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers },
    });
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', () => resolve(1));
  });
  if (code !== 0) {
    say('The download did not finish. Try again with `abject setup`.');
    return false;
  }
  if (process.platform === 'linux') {
    say('If Chromium will not start, its system libraries are missing: `sudo npx playwright install-deps chromium`.');
  }
  return true;
}

/** Start at login, through the OS's own service manager. */
async function setupService(dataDir: string): Promise<void> {
  heading('Start at login');
  const status = serviceStatus();
  if (status.installed) { say(`Abject already starts at login (${status.detail}).`); return; }
  say('Abject can start in the background whenever you log in, so agents and schedules keep running.');
  if (!(await confirmLine('Start Abject when you log in?', false))) return;
  try {
    say(await installService(dataDir));
  } catch (err) {
    say(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m`);
  }
}

/**
 * The backend half: models, permissions, and on the headless edition a
 * login, the browser and start at login. Returns true when something set
 * up needs the backend restarted to take effect (a browser download).
 */
export async function runRemoteSetup(client: AbjectClient, dataDir: string): Promise<{ restart: boolean }> {
  await setupModels(client);
  await setupPermissions(client);
  let restart = false;
  const info = await client.instanceInfo().catch(() => undefined);
  if (info?.edition === 'headless' && cliEdition() === 'headless') {
    await setupLogin(client);
    restart = await setupBrowser(dataDir);
    await setupService(dataDir);
  }
  heading('Done');
  say('Talk to the agents in the chat. Useful commands: /help, /questions, /settings, /mode.');
  say('`abject status` shows the backend; `abject stop` stops it.');
  return { restart };
}
