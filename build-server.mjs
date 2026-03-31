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
 *     server/index.js
 *     workers/abject-worker-node.js
 *     workers/ui-worker-node.js
 *     workers/p2p-worker-node.js
 */

import { build } from 'esbuild';
import { builtinModules } from 'node:module';

// All node: built-ins plus their un-prefixed variants
const nodeExternals = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

// Native / optional deps that must stay as require/import at runtime
const runtimeExternals = [
  'node-datachannel',
  'node-datachannel/polyfill',
  'ws',
  'playwright',
  'linkedom',
  'tsx/esm/api',
];

const external = [...nodeExternals, ...runtimeExternals];

const shared = {
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external,
  sourcemap: true,
  // Preserve import.meta.url so worker path resolution works
  define: {},
};

await build({
  ...shared,
  entryPoints: { 'server/index': 'server/index.ts' },
  outdir: 'dist-server',
  banner: {
    // Shim require() for ESM bundles that import CJS packages at runtime
    js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
});

// Workers are separate entry points (they run in worker_threads)
await build({
  ...shared,
  entryPoints: {
    'workers/abject-worker-node': 'workers/abject-worker-node.ts',
    'workers/ui-worker-node': 'workers/ui-worker-node.ts',
    'workers/p2p-worker-node': 'workers/p2p-worker-node.ts',
  },
  outdir: 'dist-server',
  banner: {
    js: `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);`,
  },
});

console.log('Server build complete → dist-server/');
