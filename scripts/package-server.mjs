#!/usr/bin/env node
/**
 * Package the headless server: `pnpm incarnate:server`.
 *
 * Produces release/abject-server-<version>-<platform>-<arch>.tar.gz, a
 * directory that runs on a machine with Node 22.5+ and nothing else:
 *
 *   bin/abject-server        launcher (checks Node, then runs the server)
 *   dist-server/             the compiled server and its workers (pnpm bind)
 *   native/                  bundled packages (the knowledge base)
 *   node_modules/            the runtime dependencies esbuild leaves external
 *   deploy/                  systemd unit, environment template, install notes
 *   package.json, VERSION
 *
 * node-datachannel is native, so an archive runs on the platform and
 * architecture it was built on. Playwright (the WebBrowser capability) is an
 * optional dependency and is not installed here; see deploy/README.md.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const name = `abject-server-${pkg.version}-${process.platform}-${process.arch}`;
const releaseDir = path.join(root, 'release');
const stage = path.join(releaseDir, name);

const run = (cmd, args, cwd = root) => execFileSync(cmd, args, { cwd, stdio: 'inherit' });

console.log(`package-server: building ${name}`);
run(process.execPath, ['build-server.mjs']);

fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(path.join(root, 'dist-server'), path.join(stage, 'dist-server'), { recursive: true });
fs.cpSync(path.join(root, 'native'), path.join(stage, 'native'), { recursive: true });
fs.cpSync(path.join(root, 'deploy'), path.join(stage, 'deploy'), { recursive: true });

// The dependencies build-server.mjs keeps external, minus the desktop-only
// and development-only ones (electron, tsx).
const runtimeDeps = ['ws', 'node-datachannel', 'linkedom'];
const dependencies = Object.fromEntries(runtimeDeps.map((d) => [d, pkg.dependencies[d]]));
for (const [dep, version] of Object.entries(dependencies)) {
  if (!version) throw new Error(`package.json has no dependency '${dep}'`);
}
fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({
  name: 'abject-server',
  version: pkg.version,
  private: true,
  type: 'module',
  engines: pkg.engines,
  dependencies,
  optionalDependencies: { playwright: pkg.dependencies.playwright },
  // node-datachannel's install script fetches its native binary; npm asks
  // for install scripts to be approved by name.
  allowScripts: { 'node-datachannel': true },
}, null, 2) + '\n');
fs.writeFileSync(path.join(stage, 'VERSION'), `${pkg.version}\n`);

console.log('package-server: installing runtime dependencies');
run('npm', ['install', '--omit=dev', '--omit=optional', '--no-audit', '--no-fund', '--no-package-lock'], stage);

const bin = path.join(stage, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'abject-server'), `#!/bin/sh
# Abject headless server ${pkg.version}. Configure with environment variables
# (see deploy/abject.env.example); run under systemd with deploy/abject-server.service.
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
NODE="\${NODE:-node}"
if ! "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=5)?0:1)'; then
  echo "abject-server needs Node 22.5 or newer (node:sqlite); found $("$NODE" --version 2>/dev/null || echo none)" >&2
  exit 1
fi
export ABJECTS_NATIVE_DIR="\${ABJECTS_NATIVE_DIR:-$HERE/native}"
exec "$NODE" "$HERE/dist-server/server/index.js" "$@"
`, { mode: 0o755 });

const archive = path.join(releaseDir, `${name}.tar.gz`);
fs.rmSync(archive, { force: true });
run('tar', ['-czf', archive, '-C', releaseDir, name]);
console.log(`package-server: ${archive}`);
