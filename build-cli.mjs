/**
 * Package the commune terminal client as a single self-contained executable
 * for the current platform, using Node's Single Executable Application
 * support: esbuild bundles cli/commune.ts into one CJS file, which is
 * injected into a copy of the running Node binary.
 *
 *   pnpm distill  ->  dist-cli/abject-commune-<platform>-<arch>[.exe]
 *
 * The result needs no Node install on the user's machine. It is a companion
 * to the desktop app: it connects to the CLI gateway (ws://127.0.0.1:7723)
 * of a running Abject backend.
 */

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const outDir = 'dist-cli';
fs.mkdirSync(outDir, { recursive: true });

// 1) Bundle the TUI into a single CJS file (SEA requires CommonJS).
await build({
  entryPoints: { commune: 'cli/commune.ts' },
  outfile: path.join(outDir, 'commune.cjs'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  // ws's optional native accelerators; absent at runtime, guarded by try/catch
  external: ['bufferutil', 'utf-8-validate'],
  sourcemap: false,
});

// 2) Generate the SEA preparation blob.
const seaConfig = {
  main: path.join(outDir, 'commune.cjs'),
  output: path.join(outDir, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
};
fs.writeFileSync(path.join(outDir, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(outDir, 'sea-config.json')], { stdio: 'inherit' });

// 3) Copy the Node binary and inject the blob.
const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
const binaryName = `abject-commune-${platform}-${process.arch}${platform === 'win' ? '.exe' : ''}`;
const binaryPath = path.join(outDir, binaryName);
fs.copyFileSync(process.execPath, binaryPath);
fs.chmodSync(binaryPath, 0o755);

if (platform === 'mac') {
  execFileSync('codesign', ['--remove-signature', binaryPath], { stdio: 'inherit' });
}

const postjectArgs = [
  binaryPath,
  'NODE_SEA_BLOB',
  path.join(outDir, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
];
if (platform === 'mac') {
  postjectArgs.push('--macho-segment-name', 'NODE_SEA');
}
execFileSync('pnpm', ['exec', 'postject', ...postjectArgs], { stdio: 'inherit', shell: platform === 'win' });

if (platform === 'mac') {
  // Re-sign ad hoc so macOS will execute the modified binary.
  execFileSync('codesign', ['--sign', '-', binaryPath], { stdio: 'inherit' });
}

console.log(`Terminal client packaged -> ${binaryPath}`);
