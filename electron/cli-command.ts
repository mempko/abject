/**
 * The desktop app's `abject` command, and putting it on the PATH.
 *
 * The app carries the command line in resources/cli: the CLI bundle
 * (abject.mjs) and a launcher that runs it on the app's own runtime as Node
 * (ELECTRON_RUN_AS_NODE), written per platform by electron/afterPack.cjs.
 * That copy is the desktop edition of the command: it connects to the
 * running app, and waits for the app when it is not running.
 *
 * Help → Install the abject Command puts it on the PATH:
 *
 *   Linux    a small script in ~/.local/bin. An AppImage is mounted at a new
 *            path on every launch, so its script re-enters the AppImage
 *            (whose wrapper, given ABJECT_DESKTOP_CLI, runs the command).
 *   macOS    a link in /usr/local/bin, with an administrator prompt when
 *            that folder is not writable.
 *   Windows  resources\cli added to the user's PATH.
 *
 * A command already there that this app did not write (the headless
 * edition's, say) is left alone: it talks to the desktop app too.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Marks a script this app wrote, so a later install may replace it. */
const SHIM_MARK = '# abject: written by the Abject desktop app';

export interface InstallResult {
  ok: boolean;
  message: string;
}

/** resources/cli inside the packaged app. */
function cliDir(): string {
  return path.join(process.resourcesPath, 'cli');
}

function launcherPath(): string {
  return path.join(cliDir(), process.platform === 'win32' ? 'abject.cmd' : 'abject');
}

function onPath(dir: string): boolean {
  const sep = process.platform === 'win32' ? ';' : ':';
  return (process.env.PATH ?? '').split(sep).some((p) => path.resolve(p) === path.resolve(dir));
}

function installLinux(): InstallResult {
  const binDir = path.join(os.homedir(), '.local', 'bin');
  const target = path.join(binDir, 'abject');
  // Something that runs (not ours) stays; our own script or a dead link is replaced.
  if (fs.existsSync(target)) {
    const ours = !fs.lstatSync(target).isSymbolicLink() && fs.readFileSync(target, 'utf8').includes(SHIM_MARK);
    if (!ours) {
      return { ok: true, message: `${target} is already there (the headless edition's command). It works with the desktop app as it is.` };
    }
  }
  const appImage = process.env.APPIMAGE;
  const body = appImage
    ? `ABJECT_DESKTOP_CLI=1 exec "${appImage}" "$@"`
    : `exec "${launcherPath()}" "$@"`;
  fs.mkdirSync(binDir, { recursive: true });
  try { fs.unlinkSync(target); } catch { /* none yet */ }
  fs.writeFileSync(target, `#!/bin/sh\n${SHIM_MARK}\n${body}\n`, { mode: 0o755 });
  const hint = onPath(binDir) ? '' : `\n\n${binDir} is not on your PATH yet. Add it in your shell's profile, for example:\nexport PATH="$HOME/.local/bin:$PATH"`;
  return { ok: true, message: `Installed ${target}. Open a terminal and run: abject${hint}` };
}

function installMac(): InstallResult {
  const target = '/usr/local/bin/abject';
  const source = launcherPath();
  if (fs.existsSync(target)) {
    let current = '';
    try { current = fs.readlinkSync(target); } catch { /* not a link */ }
    if (current !== source && !current.includes('.app/Contents/Resources/cli/')) {
      return { ok: true, message: `${target} is already there (the headless edition's command). It works with the desktop app as it is.` };
    }
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    try { fs.unlinkSync(target); } catch { /* none yet */ }
    fs.symlinkSync(source, target);
  } catch {
    // /usr/local/bin belongs to root on a fresh Mac: ask for the password.
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    const script = `mkdir -p /usr/local/bin && ln -sfn ${q(source)} ${q(target)}`;
    try {
      execFileSync('osascript', ['-e', `do shell script ${JSON.stringify(script)} with administrator privileges`]);
    } catch {
      return { ok: false, message: `Could not write ${target}. To do it by hand:\nsudo ln -sfn "${source}" ${target}` };
    }
  }
  return { ok: true, message: `Installed ${target}. Open a terminal and run: abject` };
}

function installWindows(): InstallResult {
  const dir = cliDir();
  const ps = `$p = [Environment]::GetEnvironmentVariable('Path', 'User'); `
    + `$d = '${dir.replace(/'/g, "''")}'; `
    + `if (-not (($p -split ';') -contains $d)) { [Environment]::SetEnvironmentVariable('Path', $(if ($p) { "$p;$d" } else { $d }), 'User') }`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
  } catch {
    return { ok: false, message: `Could not change your PATH. Add this folder to it by hand:\n${dir}` };
  }
  return { ok: true, message: `Added ${dir} to your PATH. Open a new terminal and run: abject` };
}

/** Put the app's `abject` command on the PATH. Packaged builds only. */
export function installCliCommand(): InstallResult {
  if (!fs.existsSync(path.join(cliDir(), 'abject.mjs'))) {
    return { ok: false, message: 'This build of the app does not include the abject command.' };
  }
  try {
    if (process.platform === 'linux') return installLinux();
    if (process.platform === 'darwin') return installMac();
    if (process.platform === 'win32') return installWindows();
    return { ok: false, message: `Not supported on ${process.platform}.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
