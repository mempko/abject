/**
 * Bundle the `abject` command into one ESM file: `pnpm distill`.
 *
 *   dist-cli/abject.mjs
 *
 * Self-contained apart from Node's built-ins (ws is bundled in), so it runs
 * from wherever it is copied: the headless edition's lib/cli/ (run by the
 * `abject` single-executable launcher, scripts/sea-bootstrap.cjs), and the
 * desktop app's resources/cli/ (run by the app's own Electron binary as Node).
 */

import { build } from 'esbuild';
import { builtinModules } from 'node:module';
import { readFileSync, mkdirSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

mkdirSync('dist-cli', { recursive: true });

await build({
  entryPoints: { abject: 'cli/abject.ts' },
  outdir: 'dist-cli',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // ws's optional native accelerators; absent at runtime, guarded by try/catch
  external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), 'bufferutil', 'utf-8-validate'],
  define: { __ABJECT_VERSION__: JSON.stringify(version) },
  banner: {
    // ws is CommonJS and requires Node built-ins; give the ESM bundle a require.
    js: `import { createRequire as __abjectCreateRequire } from 'node:module'; const require = __abjectCreateRequire(import.meta.url);`,
  },
  sourcemap: false,
});

console.log('CLI bundle complete → dist-cli/abject.mjs');
