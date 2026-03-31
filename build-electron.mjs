/**
 * esbuild script for compiling the Electron main process entry point.
 *
 * Electron APIs are external (resolved at runtime by Electron).
 * Node built-ins are also external.
 */

import { build } from 'esbuild';
import { builtinModules } from 'node:module';

const nodeExternals = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

await build({
  entryPoints: { main: 'electron/main.ts' },
  outdir: 'dist-electron',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: [...nodeExternals, 'electron'],
  sourcemap: true,
});

console.log('Electron main build complete → dist-electron/');
