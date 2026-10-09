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
  // ws ships in the app's node_modules (electron-builder.yml): the main
  // process reaches a backend's CLI gateway with it (cli/backend.ts), and as
  // CommonJS it cannot be inlined into this ESM bundle.
  external: [...nodeExternals, 'electron', 'ws'],
  sourcemap: true,
});

console.log('Electron main build complete → dist-electron/');
