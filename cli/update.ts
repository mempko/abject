/**
 * `abject update`: move an install made by the install script to the newest
 * release.
 *
 * The install script lays the headless edition out as
 *
 *   <root>/versions/<version>/   one directory per release (abject + lib/)
 *   <root>/current               a link to the version in use (a junction on Windows)
 *   <root>/bin/abject            -> ../current/abject (Linux, macOS)
 *
 * An update downloads the release archive for this platform, checks it
 * against the published SHA-256, unpacks it beside the others, and repoints
 * `current`. The previous version stays, so `current` can be pointed back.
 * A backend that was running restarts on the new version.
 *
 * Installs made another way (a package manager, Docker, the desktop app)
 * update through that; this says which.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { liveInstance } from '../server/instance-file.js';
import { cliEdition } from './locate.js';
import { startInBackground, stopBackend, waitForBackend } from './backend.js';

const REPO = 'mempko/abject';
const KEEP_VERSIONS = 2;

const say = (text = ''): void => { process.stdout.write(`${text}\n`); };

/** The running version: baked into the bundle (build-cli.mjs); 'dev' from source. */
export function cliVersion(): string {
  return typeof __ABJECT_VERSION__ === 'string' ? __ABJECT_VERSION__ : 'dev';
}
declare const __ABJECT_VERSION__: string | undefined;

/**
 * The install-script layout this binary runs from, if it does. Linux and
 * macOS report the real path (versions/<v>/abject); Windows reports the path
 * it was started through, the `current` junction.
 */
function installRoot(): string | undefined {
  if (process.env.ABJECT_SEA !== '1') return undefined;
  const root = /^(.*)[\\/](?:versions[\\/][^\\/]+|current)[\\/]abject(\.exe)?$/.exec(process.execPath)?.[1];
  return root && fs.existsSync(path.join(root, 'versions')) ? root : undefined;
}

function platformTag(): string {
  const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform;
  return `${os}-${process.arch}`;
}

/** Compare dotted versions numerically (1.10.0 > 1.9.3). */
export function newerThan(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

interface Release { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> }

async function latestRelease(): Promise<Release> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'abject-cli' },
  });
  if (!res.ok) throw new Error(`Could not read the latest release (${res.status} ${res.statusText}).`);
  return await res.json() as Release;
}

async function download(url: string, to: string): Promise<void> {
  const res = await fetch(url, { headers: { 'User-Agent': 'abject-cli' } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}): ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(to, buf);
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Point `<root>/current` at a version directory (junction on Windows). */
function repoint(root: string, versionDir: string): void {
  const current = path.join(root, 'current');
  const tmp = `${current}.new`;
  removeLink(tmp);
  fs.symlinkSync(versionDir, tmp, process.platform === 'win32' ? 'junction' : 'dir');
  // Replace in one step where the OS allows it (not over a Windows junction).
  try {
    fs.renameSync(tmp, current);
  } catch {
    removeLink(current);
    fs.renameSync(tmp, current);
  }
}

/** Remove a link (symlink or junction) without touching what it points at. */
function removeLink(link: string): void {
  try {
    fs.unlinkSync(link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    fs.rmdirSync(link);
  }
}

/** Drop old versions beyond the newest few (never the one in use). */
function prune(root: string, keep: string[]): void {
  const dir = path.join(root, 'versions');
  const all = fs.readdirSync(dir).sort((a, b) => (newerThan(a, b) ? -1 : 1));
  for (const name of all.slice(KEEP_VERSIONS)) {
    if (keep.includes(name)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  }
}

export async function runUpdate(opts: { checkOnly: boolean; dataDir: string }): Promise<void> {
  const current = cliVersion();
  const root = installRoot();
  if (cliEdition() === 'desktop') {
    say('This `abject` comes with the desktop app: update the app (Settings → Updates).');
    return;
  }
  if (!root) {
    say(`abject ${current}. This install was not made by the install script, so update it the way it was`);
    say('installed: your package manager (brew, winget, scoop), `docker pull`, or `git pull` in a checkout.');
    return;
  }
  const release = await latestRelease();
  const latest = release.tag_name.replace(/^v/, '');
  if (!newerThan(latest, current)) {
    say(`abject ${current} is the latest.`);
    return;
  }
  say(`abject ${latest} is available (this is ${current}).`);
  if (opts.checkOnly) return;

  const ext = process.platform === 'win32' ? 'zip' : 'tar.gz';
  const name = `abject-${latest}-${platformTag()}.${ext}`;
  const asset = release.assets.find(a => a.name === name);
  const sum = release.assets.find(a => a.name === `${name}.sha256`);
  if (!asset || !sum) throw new Error(`The release has no ${name} (with its .sha256) for this platform.`);

  const downloads = path.join(root, 'downloads');
  fs.mkdirSync(downloads, { recursive: true });
  const archive = path.join(downloads, name);
  say(`Downloading ${name}…`);
  await download(asset.browser_download_url, archive);
  await download(sum.browser_download_url, `${archive}.sha256`);
  const expected = fs.readFileSync(`${archive}.sha256`, 'utf8').trim().split(/\s+/)[0].toLowerCase();
  const actual = sha256(archive);
  if (expected !== actual) {
    fs.rmSync(archive, { force: true });
    throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}. Nothing was changed.`);
  }

  const versionDir = path.join(root, 'versions', latest);
  fs.rmSync(versionDir, { recursive: true, force: true });
  fs.mkdirSync(versionDir, { recursive: true });
  // tar unpacks zip archives too on Windows 10 and later.
  execFileSync('tar', ['-xf', archive, '-C', versionDir, '--strip-components=1'], { stdio: 'inherit' });
  if (!fs.existsSync(path.join(versionDir, process.platform === 'win32' ? 'abject.exe' : 'abject'))) {
    throw new Error(`${name} did not contain the abject binary. Nothing was switched.`);
  }

  const wasRunning = !!(await liveInstance(opts.dataDir));
  if (wasRunning) {
    say('Stopping the backend…');
    await stopBackend(opts.dataDir);
  }
  repoint(root, versionDir);
  prune(root, [latest, current]);
  fs.rmSync(archive, { force: true });
  fs.rmSync(`${archive}.sha256`, { force: true });
  say(`Updated to abject ${latest}.`);

  if (wasRunning) {
    say('Starting the backend on the new version…');
    // The new binary starts it: this process is still the old one.
    const newBinary = path.join(root, 'current', process.platform === 'win32' ? 'abject.exe' : 'abject');
    execFileSync(newBinary, ['start'], { stdio: 'inherit', env: { ...process.env, ABJECTS_DATA_DIR: opts.dataDir } });
  }
}

/** Kept for symmetry with the other commands: start on whatever binary runs. */
export async function restartBackend(dataDir: string): Promise<void> {
  await stopBackend(dataDir);
  const pid = startInBackground(dataDir);
  await waitForBackend(dataDir, { pid });
}
