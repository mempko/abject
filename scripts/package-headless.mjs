#!/usr/bin/env node
/**
 * Package the headless edition: `pnpm incarnate:headless`.
 *
 * Produces, for the platform it runs on,
 *
 *   release/abject-<version>-<os>-<arch>.tar.gz   (.zip on Windows)
 *   release/abject-<version>-<os>-<arch>.tar.gz.sha256
 *
 * an archive of one directory that needs nothing installed:
 *
 *   abject[.exe]            the command: Node with scripts/sea-bootstrap.cjs inside
 *   lib/launch.cjs          loads the CLI bundle (the binary cannot import ESM itself)
 *   lib/cli/abject.mjs      the `abject` command (pnpm distill)
 *   lib/dist-server/        the headless backend and its workers (pnpm bind): no display code
 *   lib/native/             the bundled packages (the knowledge base)
 *   lib/node_modules/       native and external modules, for this platform
 *   lib/package.json, VERSION, README.txt, LICENSE
 *
 * The binary is a copy of the Node that runs this script, so build with the
 * Node the release targets (24). node-datachannel and node-pty are native:
 * build each platform on that platform.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const os = process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'mac' : process.platform;
const name = `abject-${pkg.version}-${os}-${process.arch}`;
const releaseDir = path.join(root, 'release');
const stage = path.join(releaseDir, name);
const lib = path.join(stage, 'lib');
const exe = process.platform === 'win32' ? 'abject.exe' : 'abject';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  throw new Error(`package-headless: the binary is a copy of this Node (${process.versions.node}); build with Node 22.5 or newer (24 for releases).`);
}

const run = (cmd, args, cwd = root, extra = {}) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32', ...extra });

console.log(`package-headless: building ${name}`);
run(process.execPath, ['build-server.mjs']);
run(process.execPath, ['build-cli.mjs']);

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(path.join(lib, 'cli'), { recursive: true });

// The headless bundles only: the desktop's server, UI worker and its pool
// worker stay out, so nothing that draws ships here.
const serverFiles = [
  'server/headless.js',
  'workers/abject-worker-headless.js',
  'workers/p2p-worker-headless.js',
];
for (const rel of serverFiles) {
  for (const file of [rel, `${rel}.map`]) {
    const from = path.join(root, 'dist-server', file);
    if (!fs.existsSync(from)) continue;
    const to = path.join(lib, 'dist-server', file);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}
fs.copyFileSync(path.join(root, 'dist-cli', 'abject.mjs'), path.join(lib, 'cli', 'abject.mjs'));
fs.cpSync(path.join(root, 'native'), path.join(lib, 'native'), {
  recursive: true,
  filter: (src) => {
    // Package sources stay behind; the built modules and their docs ship.
    const stat = fs.statSync(src);
    if (stat.isDirectory()) return !/(^|[\\/])(src|build|node_modules)$/.test(src);
    return /\.(json|wasm|md)$/.test(src);
  },
});
fs.writeFileSync(path.join(lib, 'launch.cjs'), `'use strict';
// Loaded by the abject binary's entry (sea-bootstrap.cjs), which cannot
// import an ES module itself.
const { pathToFileURL } = require('node:url');
const path = require('node:path');
import(pathToFileURL(path.join(__dirname, 'cli', 'abject.mjs')).href).catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
`);

// The modules the server and the CLI keep external: native ones, and ones
// loaded lazily (node-pty for the CLI-agent providers, Playwright for web
// browsing; browsers are downloaded by \`abject setup\`, not shipped).
const runtimeDeps = ['ws', 'node-datachannel', 'linkedom', '@lydell/node-pty', 'playwright'];
const dependencies = Object.fromEntries(runtimeDeps.map((d) => {
  const v = pkg.dependencies[d];
  if (!v) throw new Error(`package.json has no dependency '${d}'`);
  return [d, v];
}));
fs.writeFileSync(path.join(lib, 'package.json'), JSON.stringify({
  name: 'abject-headless',
  version: pkg.version,
  private: true,
  type: 'module',
  dependencies,
  // node-datachannel's install script fetches its native binary.
  allowScripts: { 'node-datachannel': true },
}, null, 2) + '\n');
console.log('package-headless: installing runtime dependencies');
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock'], lib,
  // Playwright's own browser download is skipped: setup fetches Chromium on request.
  { env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' } });

// The binary: this Node with the bootstrap injected (Node single executable).
console.log('package-headless: building the abject binary');
const seaDir = path.join(releaseDir, `${name}-sea`);
fs.rmSync(seaDir, { recursive: true, force: true });
fs.mkdirSync(seaDir, { recursive: true });
const seaConfig = path.join(seaDir, 'sea-config.json');
const blob = path.join(seaDir, 'sea-prep.blob');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(root, 'scripts', 'sea-bootstrap.cjs'),
  output: blob,
  disableExperimentalSEAWarning: true,
}, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });
const binary = path.join(stage, exe);
fs.copyFileSync(process.execPath, binary);
fs.chmodSync(binary, 0o755);
if (process.platform === 'darwin') execFileSync('codesign', ['--remove-signature', binary], { stdio: 'inherit' });
const postject = ['exec', 'postject', binary, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'];
if (process.platform === 'darwin') postject.push('--macho-segment-name', 'NODE_SEA');
run('pnpm', postject);
// macOS runs only signed binaries: sign ad hoc (a Developer ID signature is a release-time step).
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', binary], { stdio: 'inherit' });
fs.rmSync(seaDir, { recursive: true, force: true });

fs.writeFileSync(path.join(stage, 'VERSION'), `${pkg.version}\n`);
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, 'LICENSE'));
fs.writeFileSync(path.join(stage, 'README.txt'), `Abject ${pkg.version}, headless edition (${os}-${process.arch})

Run ./${exe} to talk to the agents. The first run walks you through setup and
starts the backend in the background; it keeps running when you quit.

  ./${exe}              open the chat
  ./${exe} setup        guided setup
  ./${exe} status       what is running, and what is waiting on you
  ./${exe} stop         stop the background backend
  ./${exe} serve        run the backend in the foreground (systemd, Docker)
  ./${exe} help         every command

Data lives in the OS's per-user location (~/.config/abject on Linux,
~/Library/Application Support/abject on macOS, %APPDATA%\\abject on Windows),
shared with the desktop app. Set ABJECTS_DATA_DIR to use another.

Install with the script at https://abject.world/install to get \`abject\` on
your PATH and \`abject update\`.
`);

// Smoke test: the binary runs its own command line.
const smoke = execFileSync(binary, ['version'], { encoding: 'utf8' }).trim();
if (smoke !== pkg.version) throw new Error(`package-headless: the binary reported '${smoke}', expected ${pkg.version}`);

const archive = path.join(releaseDir, `${name}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`);
fs.rmSync(archive, { force: true });
if (process.platform === 'win32') {
  run('tar', ['-a', '-c', '-f', archive, '-C', releaseDir, name]);
} else {
  run('tar', ['-czf', archive, '-C', releaseDir, name]);
}
const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.writeFileSync(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
console.log(`package-headless: ${archive}`);
console.log(`package-headless: sha256 ${digest}`);
