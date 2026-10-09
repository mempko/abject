/**
 * `abject service install|uninstall|status`: start the headless backend
 * when the person logs in, through the OS's own mechanism.
 *
 *   Linux    a systemd user unit (abject.service)
 *   macOS    a LaunchAgent (world.abject.headless)
 *   Windows  a Task Scheduler task at logon (Abject)
 *
 * The service runs `abject serve` in the foreground, so the service manager
 * owns its lifetime and restarts it on failure. A backend already running in
 * the background is stopped first: two backends cannot share a data directory.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { require as contractRequire } from '../src/core/contracts.js';
import { cliEdition } from './locate.js';
import { logFilePath, stopBackend } from './backend.js';

const UNIT_NAME = 'abject.service';
const AGENT_LABEL = 'world.abject.headless';
const TASK_NAME = 'Abject';

function systemdUnitPath(): string {
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'systemd', 'user', UNIT_NAME);
}

function launchAgentPath(): string {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

/**
 * The command a service should run: the stable path of an install
 * (`<root>/current/abject`, `current` being the link an update repoints),
 * else this binary.
 */
export function launcherCommand(): string[] {
  contractRequire(cliEdition() === 'headless', 'Start at login is for the headless edition; the desktop app has its own setting for this.');
  if (process.env.ABJECT_SEA === '1') {
    const versioned = /^(.*)[\\/]versions[\\/][^\\/]+[\\/](abject(?:\.exe)?)$/.exec(process.execPath);
    if (versioned) {
      const stable = path.join(versioned[1], 'current', versioned[2]);
      if (fs.existsSync(stable)) return [stable];
    }
    return [process.execPath];
  }
  return [process.execPath, process.argv[1]!];
}

function run(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function serviceStatus(): { installed: boolean; detail: string } {
  if (process.platform === 'linux') {
    if (!fs.existsSync(systemdUnitPath())) return { installed: false, detail: 'not installed' };
    let state = 'installed';
    try { state = run('systemctl', ['--user', 'is-active', UNIT_NAME]); } catch { state = 'installed, inactive'; }
    return { installed: true, detail: `systemd user unit ${UNIT_NAME}: ${state}` };
  }
  if (process.platform === 'darwin') {
    return fs.existsSync(launchAgentPath())
      ? { installed: true, detail: `LaunchAgent ${AGENT_LABEL}` }
      : { installed: false, detail: 'not installed' };
  }
  if (process.platform === 'win32') {
    try { run('schtasks', ['/Query', '/TN', TASK_NAME]); return { installed: true, detail: `scheduled task ${TASK_NAME}` }; }
    catch { return { installed: false, detail: 'not installed' }; }
  }
  return { installed: false, detail: `not supported on ${process.platform}` };
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export async function installService(dataDir: string): Promise<string> {
  const command = launcherCommand();
  // The service manager owns the backend from now on; one already running
  // in the background would hold the data directory.
  await stopBackend(dataDir);

  if (process.platform === 'linux') {
    const unit = `[Unit]
Description=Abject (headless)
After=network-online.target

[Service]
ExecStart=${command.map(c => (/\s/.test(c) ? `"${c}"` : c)).join(' ')} serve
Environment=ABJECTS_DATA_DIR=${dataDir}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    fs.mkdirSync(path.dirname(systemdUnitPath()), { recursive: true });
    fs.writeFileSync(systemdUnitPath(), unit);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', UNIT_NAME]);
    return `Installed ${systemdUnitPath()} and started it. To keep it running while you are logged out: loginctl enable-linger ${os.userInfo().username}`;
  }

  if (process.platform === 'darwin') {
    const log = logFilePath(dataDir);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[...command, 'serve'].map(a => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>ABJECTS_DATA_DIR</key><string>${xml(dataDir)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
    fs.mkdirSync(path.dirname(launchAgentPath()), { recursive: true });
    fs.writeFileSync(launchAgentPath(), plist);
    const domain = `gui/${process.getuid?.() ?? ''}`;
    try { run('launchctl', ['bootout', domain, launchAgentPath()]); } catch { /* not loaded */ }
    run('launchctl', ['bootstrap', domain, launchAgentPath()]);
    return `Installed ${launchAgentPath()} and started it.`;
  }

  if (process.platform === 'win32') {
    // `start` returns once the backend is up and leaves it running hidden; a
    // foreground `serve` would hold a console window open all session.
    const exe = command[0];
    const tr = command.length > 1
      ? `"${exe}" "${command[1]}" start`
      : `"${exe}" start`;
    run('schtasks', ['/Create', '/TN', TASK_NAME, '/TR', tr, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F']);
    try { run('schtasks', ['/Run', '/TN', TASK_NAME]); } catch { /* starts at next logon */ }
    return `Created the scheduled task "${TASK_NAME}" (at logon) and started it.`;
  }

  throw new Error(`Start at login is not supported on ${process.platform}.`);
}

export async function uninstallService(): Promise<string> {
  if (process.platform === 'linux') {
    if (!fs.existsSync(systemdUnitPath())) return 'Not installed.';
    try { run('systemctl', ['--user', 'disable', '--now', UNIT_NAME]); } catch { /* already stopped */ }
    fs.rmSync(systemdUnitPath(), { force: true });
    try { run('systemctl', ['--user', 'daemon-reload']); } catch { /* best effort */ }
    return `Removed ${UNIT_NAME}.`;
  }
  if (process.platform === 'darwin') {
    if (!fs.existsSync(launchAgentPath())) return 'Not installed.';
    try { run('launchctl', ['bootout', `gui/${process.getuid?.() ?? ''}`, launchAgentPath()]); } catch { /* not loaded */ }
    fs.rmSync(launchAgentPath(), { force: true });
    return `Removed ${AGENT_LABEL}.`;
  }
  if (process.platform === 'win32') {
    try { run('schtasks', ['/Delete', '/TN', TASK_NAME, '/F']); return `Removed the scheduled task "${TASK_NAME}".`; }
    catch { return 'Not installed.'; }
  }
  return 'Not installed.';
}
