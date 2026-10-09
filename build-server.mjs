/**
 * esbuild script for compiling the server and worker entry points to JS.
 *
 * Used by the Electron packaging pipeline. The dev workflow (tsx --watch)
 * is unaffected — this script is only invoked via `pnpm bind`.
 *
 * Output structure mirrors the source layout so that relative URL
 * resolution (e.g. `new URL('../workers/…', import.meta.url)`) still
 * works in the compiled output after swapping .ts → .js extensions.
 *
 *   dist-server/
 *     server/index.js                    desktop edition
 *     server/headless.js                 headless edition (no display code)
 *     workers/abject-worker-node.js      desktop pool worker
 *     workers/abject-worker-headless.js  headless pool worker
 *     workers/ui-worker-node.js
 *     workers/p2p-worker-node.js         desktop P2P worker (with remote UI pairing)
 *     workers/p2p-worker-headless.js     headless P2P worker
 *
 * The headless bundles are checked after the build: a window, a widget or
 * the display server reaching them fails the build (scripts/headless-bundle-check.mjs).
 */

import { build } from 'esbuild';
import { checkHeadlessBundle } from './scripts/headless-bundle-check.mjs';
import { builtinModules } from 'node:module';
import { readFileSync } from 'node:fs';

// Baked in so the compiled server reports its release without package.json.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

// All node: built-ins plus their un-prefixed variants
const nodeExternals = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

// Native / optional deps that must stay as require/import at runtime
const runtimeExternals = [
  'node-datachannel',
  'node-datachannel/polyfill',
  // Native: loads its platform binary by package name at runtime, which a
  // bundle cannot follow (the CLI-agent providers' pseudo-terminal).
  '@lydell/node-pty',
  'ws',
  'playwright',
  // Only the desktop app's main thread imports it (BrowserWindowHost);
  // Electron resolves it at runtime.
  'electron',
  // Only the packaged desktop app loads it (AppUpdater), from the app's own
  // node_modules; the headless server package does not ship it.
  'electron-updater',
  'linkedom',
  'tsx/esm/api',
];

const external = [...nodeExternals, ...runtimeExternals];

const shared = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  external,
  sourcemap: true,
  // Preserve import.meta.url so worker path resolution works
  define: { __ABJECT_VERSION__: JSON.stringify(version) },
};

const serverBuild = await build({
  ...shared,
  metafile: true,
  entryPoints: { 'server/index': 'server/index.ts', 'server/headless': 'server/headless.ts' },
  outdir: 'dist-server',
  banner: {
    // Shim require() for ESM bundles that import CJS packages at runtime
    // Alias the imported binding so it can't collide with a `createRequire`
    // import inside a bundled ESM dependency (e.g. fflate).
    js: `import { createRequire as __abjectsCreateRequire } from 'node:module'; const require = __abjectsCreateRequire(import.meta.url);`,
  },
});

// Workers are separate entry points (they run in worker_threads)
const workerBuild = await build({
  ...shared,
  metafile: true,
  entryPoints: {
    'workers/abject-worker-node': 'workers/abject-worker-node.ts',
    'workers/abject-worker-headless': 'workers/abject-worker-headless.ts',
    'workers/ui-worker-node': 'workers/ui-worker-node.ts',
    'workers/p2p-worker-node': 'workers/p2p-worker-node.ts',
    'workers/p2p-worker-headless': 'workers/p2p-worker-headless.ts',
  },
  outdir: 'dist-server',
  banner: {
    // Alias the imported binding so it can't collide with a `createRequire`
    // import inside a bundled ESM dependency (e.g. fflate).
    js: `import { createRequire as __abjectsCreateRequire } from 'node:module'; const require = __abjectsCreateRequire(import.meta.url);`,
  },
});

checkHeadlessBundle(serverBuild.metafile, 'dist-server/server/headless.js');
checkHeadlessBundle(workerBuild.metafile, 'dist-server/workers/abject-worker-headless.js');
checkHeadlessBundle(workerBuild.metafile, 'dist-server/workers/p2p-worker-headless.js');

console.log('Server build complete → dist-server/');
