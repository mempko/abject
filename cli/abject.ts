/**
 * abject -- the command line for Abject.
 *
 *   abject                    talk to the agents (starts the headless backend if needed)
 *   abject --plain            a line-oriented REPL instead of the full-screen TUI
 *   abject setup              guided setup
 *   abject start|stop|restart the background backend
 *   abject status             what is running, and what is waiting on you
 *   abject logs [-f]          the background backend's log
 *   abject serve              run the backend in the foreground (systemd, launchd, Docker)
 *   abject questions          list the questions waiting on you; abject answer N <choice>
 *   abject mode [ask|allow|deny]   what happens to a permission request nobody answers
 *   abject settings ...       /get and /set, from the shell
 *   abject service install|uninstall|status   start at login
 *   abject update [--check]   move an install-script install to the newest release
 *   abject doctor             check the install
 *
 * It works the same against the desktop app and the headless edition: it
 * connects to whatever backend runs on the data directory. The headless
 * edition's copy starts one in the background when none is running (and the
 * backend keeps running after the TUI closes); the desktop app's copy waits
 * for the app. `pnpm abject` runs it from a source checkout.
 */

import { loadCliConfig } from './config.js';
import { cliDataDir, cliEdition, dataDirInUse, findBackend, type BackendTarget } from './locate.js';
import { confirmLine, connectClient } from './connect.js';
import { runTui, runPlain } from './chat-ui.js';
import {
  canServe, logFilePath, serve, showLogs, startInBackground, stopBackend, waitForBackend,
} from './backend.js';
import { runLocalSetup, runRemoteSetup } from './setup.js';
import { installService, serviceStatus, uninstallService } from './service.js';
import { cliVersion, restartBackend, runUpdate } from './update.js';
import { runDoctor } from './doctor.js';
import { liveInstance, readInstance } from '../server/instance-file.js';
import { isSettingsCommand, runSettingsCommand, settingsErrorText } from './settings.js';
import { stripAnsi } from './markdown.js';
import type { DialogInfo } from './client.js';

const HELP = `abject ${cliVersion()} -- talk to Abject's agents from a terminal

usage: abject [command] [--data-dir DIR] [--url ws://host:port] [--plain]

  (no command)        open the chat (starts the backend if this edition can)
  setup               guided setup: models, permissions, and more
  start | stop | restart   the background backend
  status              what is running, and what is waiting on you
  logs [-f]           the background backend's log
  serve               run the backend in the foreground (for service managers)
  questions           list the questions waiting on you
  answer N <choice>   answer question N: an option number, yes/no, or text
  mode [ask|allow|deny]    permission requests nobody answers: ask, allow, or deny
  settings get|set ...     read or change settings (see \`abject settings help\`)
  service install|uninstall|status   start the backend when you log in
  update [--check]    update an install made by the install script
  doctor              check the install
  version             print the version

The chat:  C-a c opens a chat, C-a 1..9 switches tabs, /help lists commands,
/questions lists permission prompts waiting on you. Quitting leaves the
backend running; \`abject stop\` stops it.

env: ABJECTS_DATA_DIR, ABJECT_PREFIX, ABJECTS_AUTH_USER, ABJECTS_AUTH_PASSWORD`;

interface Args {
  command: string;
  rest: string[];
  dataDir?: string;
  url?: string;
  plain: boolean;
  follow: boolean;
  check: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: '', rest: [], plain: false, follow: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--data-dir') { args.dataDir = argv[++i]; continue; }
    if (a === '--url') { args.url = argv[++i]; continue; }
    if (a === '--plain') { args.plain = true; continue; }
    if (a === '-f' || a === '--follow') { args.follow = true; continue; }
    if (a === '--check') { args.check = true; continue; }
    if (a === '-h' || a === '--help') { args.command = 'help'; continue; }
    if (a === '-v' || a === '--version') { args.command = 'version'; continue; }
    if (!args.command) args.command = a;
    else args.rest.push(a);
  }
  return args;
}

const say = (text = ''): void => { process.stdout.write(`${text}\n`); };

/** Overwrite one status line while waiting. */
function waiting(text: string): void {
  if (process.stdout.isTTY) process.stdout.write(`\r\x1b[2K${text}`);
}

/**
 * The backend to talk to, starting or waiting for one as this edition does:
 * the headless edition starts its own; the desktop app's copy and a source
 * checkout wait for one to appear.
 */
async function ensureBackend(dataDir: string, url: string | undefined, startIfMissing: boolean): Promise<{ target: BackendTarget; started: boolean }> {
  const found = await findBackend(dataDir, url);
  if (found) return { target: found, started: false };
  if (url) throw new Error(`Nothing answers at ${url}.`);

  if (startIfMissing && canServe()) {
    waiting('Starting Abject…');
    const pid = startInBackground(dataDir);
    await waitForBackend(dataDir, { pid, onWait: (s) => waiting(`Starting Abject… ${s}s`) });
    if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
    const target = await findBackend(dataDir);
    if (!target) throw new Error('The backend started but cannot be found.');
    return { target, started: true };
  }

  const hint = cliEdition() === 'desktop'
    ? 'Waiting for the Abject app to start (Ctrl+C to quit)…'
    : 'Waiting for a backend (`pnpm awaken`, or `pnpm abject start`; Ctrl+C to quit)…';
  say(hint);
  for (;;) {
    await new Promise((r) => setTimeout(r, 1000));
    const target = await findBackend(dataDir);
    if (target) return { target, started: false };
  }
}

/** Open the chat, offering setup first on an instance with no model. */
async function chat(args: Args, dataDir: string): Promise<void> {
  const interactive = !!process.stdin.isTTY && !!process.stdout.isTTY && !args.plain;
  // A first run of the headless edition: choose where data lives before
  // there is a backend holding it.
  if (interactive && cliEdition() === 'headless' && !args.url
      && !dataDirInUse(dataDir) && !(await findBackend(dataDir))) {
    dataDir = await runLocalSetup(dataDir);
  }
  let { target } = await ensureBackend(dataDir, args.url, cliEdition() === 'headless');

  if (interactive) {
    const client = await connectClient(target);
    const configured = await client.isConfigured().catch(() => true);
    if (!configured && await confirmLine('No AI model is set up yet. Run guided setup now?', true)) {
      const { restart } = await runRemoteSetup(client, dataDir);
      client.close();
      if (restart && target.instance?.edition === 'headless') {
        say('Restarting the backend to pick up the browser…');
        await restartBackend(dataDir);
        target = (await findBackend(dataDir)) ?? target;
      }
    } else {
      client.close();
    }
  }

  const farewell = target.instance?.edition === 'headless'
    ? 'Abject keeps running in the background; `abject stop` stops it.'
    : undefined;
  if (args.plain || !process.stdout.isTTY || !process.stdin.isTTY) await runPlain(target);
  else await runTui(target, { farewell });
}

/** `abject status`. */
async function status(dataDir: string, url?: string): Promise<void> {
  const target = await findBackend(dataDir, url);
  if (!target) {
    say(`Not running. Data directory: ${dataDir}`);
    say(cliEdition() === 'desktop' ? 'Start the Abject app.' : 'Start it with `abject` or `abject start`.');
    process.exitCode = 3;
    return;
  }
  const client = await connectClient(target);
  try {
    const [info, configured, dialogs, workspaces] = await Promise.all([
      client.instanceInfo().catch(() => undefined),
      client.isConfigured().catch(() => undefined),
      client.listDialogs().catch(() => [] as DialogInfo[]),
      client.listWorkspaces().catch(() => []),
    ]);
    const inst = target.instance;
    say(`Abject ${info?.version ?? inst?.version ?? '?'} (${info?.edition ?? inst?.edition ?? '?'}) is running`);
    if (inst) say(`  pid ${inst.pid}, gateway ws://127.0.0.1:${inst.cliPort}, health http://127.0.0.1:${inst.wsPort}/healthz`);
    else say(`  gateway ${target.url}`);
    if (info) say(`  up ${Math.round(info.uptimeSec / 60)} min, ${info.workerCount} worker(s), ${info.display ? 'with' : 'no'} display`);
    if (inst) say(`  data ${inst.dataDir}`);
    say(`  ${workspaces.length} workspace(s); AI model ${configured === false ? 'NOT configured (abject setup)' : 'configured'}`);
    if (dialogs.length > 0) {
      say(`  ${dialogs.length} question(s) waiting on you:`);
      dialogs.forEach((d, i) => say(`    ${i + 1}. ${d.title}${d.resource ? `: ${d.resource.slice(0, 90)}` : ''}`));
    }
  } finally {
    client.close();
  }
}

/** `abject questions`. */
async function questions(dataDir: string, url?: string): Promise<void> {
  const { target } = await ensureBackend(dataDir, url, false);
  const client = await connectClient(target);
  try {
    const open = await client.listDialogs();
    if (open.length === 0) { say('No questions are waiting.'); return; }
    open.forEach((d, i) => {
      say(`${i + 1}. ${d.title}${d.askedBy && d.topic !== 'permission' ? ` (${d.askedBy})` : ''}`);
      for (const l of d.message.split('\n')) say(`   ${l}`);
      if (d.resource) say(`   ${d.resource}`);
      if (d.kind === 'options') d.options?.forEach((o, j) => say(`     [${j + 1}] ${o.label}`));
      else say(d.kind === 'prompt' ? '     answer with text' : '     answer yes or no');
    });
    say('\nAnswer with: abject answer <question> <option number | yes | no | text>');
  } finally {
    client.close();
  }
}

/** `abject answer N <choice>`. */
async function answer(dataDir: string, url: string | undefined, rest: string[]): Promise<void> {
  const n = parseInt(rest[0] ?? '', 10);
  const choice = rest.slice(1).join(' ').trim();
  if (!n) throw new Error('usage: abject answer <question number> <option number | yes | no | text>');
  const { target } = await ensureBackend(dataDir, url, false);
  const client = await connectClient(target);
  try {
    const dialog = (await client.listDialogs())[n - 1];
    if (!dialog) throw new Error(`No question ${n} (abject questions lists them).`);
    const no = /^(n|no|deny|cancel)$/i.test(choice);
    if (dialog.kind === 'options') {
      const option = dialog.options?.[parseInt(choice, 10) - 1];
      if (!no && !option) throw new Error('Pick one of the numbered options, or no.');
      await client.respondDialog(dialog.dialogId, !no, undefined, no ? undefined : option!.id);
    } else if (dialog.kind === 'confirm') {
      await client.respondDialog(dialog.dialogId, !no && /^(y|yes|ok)$/i.test(choice));
    } else {
      await client.respondDialog(dialog.dialogId, !no, no ? undefined : choice);
    }
    say(`Answered: ${dialog.title}`);
  } finally {
    client.close();
  }
}

/** `abject mode [ask|allow|deny]`. */
async function mode(dataDir: string, url: string | undefined, value?: string): Promise<void> {
  const { target } = await ensureBackend(dataDir, url, false);
  const client = await connectClient(target);
  try {
    if (!value) {
      const current = await client.request<{ mode: string }>('getSettings', { section: 'permissions' });
      say(`Permission requests nobody answers: ${current.mode} (ask | allow | deny)`);
      return;
    }
    if (!['ask', 'allow', 'deny'].includes(value)) throw new Error('mode is one of ask, allow, deny');
    await client.request('setSettings', { section: 'permissions', values: { mode: value } }, 60_000);
    say(`Permission requests nobody answers: ${value}`);
  } finally {
    client.close();
  }
}

/** `abject settings <cmd> ...`: the TUI's settings commands from the shell. */
async function settings(dataDir: string, url: string | undefined, rest: string[]): Promise<void> {
  const [cmd = 'help', ...args] = rest;
  const { target } = await ensureBackend(dataDir, url, false);
  const client = await connectClient(target);
  try {
    if (!isSettingsCommand(cmd)) throw new Error(`Unknown settings command: ${cmd}. Try: abject settings get ai`);
    const workspaces = await client.listWorkspaces();
    const ws = workspaces.find(w => w.active) ?? workspaces[0];
    for (const line of await runSettingsCommand(client, cmd, args, ws ? { id: ws.id, name: ws.name } : undefined)) {
      say(stripAnsi(line.text));
    }
  } finally {
    client.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = loadCliConfig();
  const dataDir = cliDataDir(config, args.dataDir);

  switch (args.command) {
    case '':
    case 'chat':
      return chat(args, dataDir);
    case 'help':
      say(HELP);
      return;
    case 'version':
      say(cliVersion());
      return;
    case 'setup': {
      let dir = dataDir;
      if (cliEdition() === 'headless' && !(await findBackend(dir, args.url))) dir = await runLocalSetup(dir);
      const { target } = await ensureBackend(dir, args.url, cliEdition() === 'headless');
      const client = await connectClient(target);
      const { restart } = await runRemoteSetup(client, dir);
      client.close();
      if (restart && target.instance?.edition === 'headless') {
        say('Restarting the backend to pick up the browser…');
        await restartBackend(dir);
      }
      return;
    }
    case 'serve':
      return serve(dataDir);
    case 'start': {
      const { target, started } = await ensureBackend(dataDir, undefined, true);
      say(started ? `Started (gateway ${target.url}). Log: ${logFilePath(dataDir)}` : `Already running (gateway ${target.url}).`);
      return;
    }
    case 'stop': {
      // The desktop app's backend ends with the app; quitting it is the app's own act.
      if (readInstance(dataDir)?.edition === 'desktop' && await liveInstance(dataDir)) {
        throw new Error('The desktop app is running this backend: quit the app to stop it.');
      }
      const result = await stopBackend(dataDir);
      say(result === 'stopped' ? 'Stopped.' : 'Not running.');
      return;
    }
    case 'restart':
      if (!canServe() || (readInstance(dataDir)?.edition === 'desktop' && await liveInstance(dataDir))) {
        throw new Error('The desktop app runs this backend: restart the app.');
      }
      await restartBackend(dataDir);
      say('Restarted.');
      return;
    case 'status':
      return status(dataDir, args.url);
    case 'logs':
      return showLogs(dataDir, args.follow);
    case 'questions':
    case 'dialogs':
      return questions(dataDir, args.url);
    case 'answer':
      return answer(dataDir, args.url, args.rest);
    case 'mode':
      return mode(dataDir, args.url, args.rest[0]);
    case 'settings':
      return settings(dataDir, args.url, args.rest);
    case 'service': {
      const sub = args.rest[0] ?? 'status';
      if (sub === 'install') say(await installService(dataDir));
      else if (sub === 'uninstall') say(await uninstallService());
      else if (sub === 'status') say(serviceStatus().detail);
      else throw new Error('usage: abject service install|uninstall|status');
      return;
    }
    case 'update':
      return runUpdate({ checkOnly: args.check, dataDir });
    case 'doctor':
      return runDoctor(dataDir);
    default:
      throw new Error(`Unknown command: ${args.command}. Try: abject help`);
  }
}

main().catch((err) => {
  // The TUI may have the screen; give it back before the message.
  if (process.stdout.isTTY) process.stdout.write('\x1b[?25h\x1b[?1049l');
  process.stderr.write(`${settingsErrorText(err)}\n`);
  process.exit(1);
});
