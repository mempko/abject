/**
 * The entry of the packaged `abject` binary, a Node single executable.
 *
 * The binary is the Node runtime with this small script inside it; everything
 * else is plain files beside it in lib/ (the CLI bundle, the headless server
 * and its workers, native modules, the bundled packages). Keeping them as
 * files is what lets worker threads, native addons and the WASM packages load
 * the way they do under plain Node.
 *
 * A single executable runs only its own entry and passes every argument
 * through, so the two things the backend and setup need Node itself for come
 * in as reserved first arguments:
 *
 *   __abject-eval            run the code in ABJECT_EVAL (the backend's exit
 *                            watchdog, which plain Node would take as `-e`)
 *   __abject-run <script>    run a CommonJS script as `node <script> ...`
 *                            (Playwright's installer, from `abject setup`)
 *
 * Anything else is the `abject` command line.
 */

'use strict';

const path = require('node:path');
const { createRequire } = require('node:module');

const home = path.dirname(process.execPath);
process.env.ABJECT_SEA = '1';
if (!process.env.ABJECT_HOME) process.env.ABJECT_HOME = home;
if (!process.env.ABJECT_EDITION) process.env.ABJECT_EDITION = 'headless';

const mode = process.argv[2];

if (mode === '__abject-eval') {
  require('node:vm').runInThisContext(String(process.env.ABJECT_EVAL || ''), { filename: 'abject-eval.js' });
} else if (mode === '__abject-run') {
  const script = path.resolve(process.argv[3] || '');
  process.argv = [process.argv[0], script, ...process.argv.slice(4)];
  createRequire(script)(script);
} else {
  // Loaded through a require rooted in lib/, whose module can use import():
  // the single-executable entry itself cannot load ES modules.
  createRequire(path.join(home, 'lib', 'launch.cjs'))('./launch.cjs');
}
