#!/usr/bin/env node
/**
 * Fill the package-manager manifests in packaging/ for a release:
 *
 *   node scripts/fill-manifests.mjs <version> <dir with the release's .sha256 files>
 *
 * writes packaging/out/<version>/ with the Homebrew formula, the Scoop
 * manifest and the winget manifests, from the templates (*.tmpl) beside
 * them. Publishing is a separate, deliberate step: the formula goes to the
 * tap, the Scoop manifest to the bucket, the winget manifests to a pull
 * request on microsoft/winget-pkgs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [version, sumsDir] = process.argv.slice(2);
if (!version || !sumsDir) {
  console.error('usage: node scripts/fill-manifests.mjs <version> <dir with abject-<version>-*.sha256>');
  process.exit(1);
}

const targets = {
  linux_x64: `abject-${version}-linux-x64.tar.gz`,
  linux_arm64: `abject-${version}-linux-arm64.tar.gz`,
  mac_arm64: `abject-${version}-mac-arm64.tar.gz`,
  mac_x64: `abject-${version}-mac-x64.tar.gz`,
  win_x64: `abject-${version}-win-x64.zip`,
};
const values = { version, license: 'GPL-3.0-or-later' };
for (const [key, archive] of Object.entries(targets)) {
  const file = path.join(sumsDir, `${archive}.sha256`);
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  const sum = fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(sum)) throw new Error(`${file} does not hold a SHA-256`);
  values[`sha256_${key}`] = sum;
  values[`SHA256_${key.toUpperCase()}`] = sum.toUpperCase();
}

const out = path.join(root, 'packaging', 'out', version);
fs.mkdirSync(out, { recursive: true });
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() && e.name !== 'out' ? walk(path.join(dir, e.name)) : e.name.endsWith('.tmpl') ? [path.join(dir, e.name)] : []);
for (const tmpl of walk(path.join(root, 'packaging'))) {
  const text = fs.readFileSync(tmpl, 'utf8').replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (!(key in values)) throw new Error(`${tmpl}: no value for ${m}`);
    return values[key];
  });
  const dest = path.join(out, path.basename(tmpl, '.tmpl'));
  fs.writeFileSync(dest, text);
  console.log(`fill-manifests: ${path.relative(root, dest)}`);
}
