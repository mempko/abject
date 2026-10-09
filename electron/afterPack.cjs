/**
 * electron-builder afterPack hook.
 *
 * Every platform: writes the launcher of the app's `abject` command into
 * resources/cli, beside the CLI bundle (extraResources): it runs abject.mjs
 * on the app's own binary as Node (ELECTRON_RUN_AS_NODE), as the desktop
 * edition of the command. See electron/cli-command.ts.
 *
 * Linux: renames the real Electron binary to .bin and replaces it with a shell
 * wrapper that passes --no-sandbox. This is the only reliable way to
 * disable the Chromium sandbox because the zygote process checks it
 * before any JS executes.
 *
 * Required because:
 * - AppImage cannot host SUID chrome-sandbox binaries
 * - Ubuntu 23.10+ blocks unprivileged user namespaces via AppArmor
 *
 * Same technique used by VS Code (PR #81096) and recommended in
 * electron-builder issue #5371.
 */

const fs = require('fs');
const path = require('path');

/** resources/cli/abject[.cmd]: run the CLI bundle on the app's runtime. */
function writeCliLauncher(cliDir, platform, binaryFromCli) {
  if (!fs.existsSync(path.join(cliDir, 'abject.mjs'))) {
    console.warn('afterPack: no resources/cli/abject.mjs (run pnpm distill); the app ships without the abject command');
    return;
  }
  if (platform === 'win32') {
    fs.writeFileSync(path.join(cliDir, 'abject.cmd'), [
      '@echo off',
      'rem The Abject desktop app\'s abject command: the app\'s runtime, run as Node.',
      'setlocal',
      'set ELECTRON_RUN_AS_NODE=1',
      'set ABJECT_EDITION=desktop',
      `"%~dp0${binaryFromCli.replace(/\//g, '\\')}" "%~dp0abject.mjs" %*`,
      '',
    ].join('\r\n'));
    return;
  }
  fs.writeFileSync(path.join(cliDir, 'abject'), [
    '#!/bin/sh',
    "# The Abject desktop app's abject command: the app's runtime, run as Node.",
    'here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)',
    `ELECTRON_RUN_AS_NODE=1 ABJECT_EDITION=desktop exec "$here/${binaryFromCli}" "$here/abject.mjs" "$@"`,
    '',
  ].join('\n'), { mode: 0o755 });
}

module.exports = async function afterPack({ targets, appOutDir, electronPlatformName, packager }) {
  const productFilename = packager.appInfo.productFilename;
  if (electronPlatformName === 'darwin') {
    writeCliLauncher(path.join(appOutDir, `${productFilename}.app`, 'Contents', 'Resources', 'cli'), 'darwin', `../../MacOS/${productFilename}`);
    return;
  }
  if (electronPlatformName === 'win32') {
    writeCliLauncher(path.join(appOutDir, 'resources', 'cli'), 'win32', `../../${productFilename}.exe`);
    return;
  }

  // The sandbox wrapper is for the Linux package formats; an unpacked
  // `dir` build keeps the bare binary (and still gets the command).
  const wrap = !!targets.find(t => /AppImage|snap|deb|rpm|freebsd|pacman/i.test(t.name));

  // Remove SUID sandbox helper if present
  const sandbox = path.join(appOutDir, 'chrome-sandbox');
  if (fs.existsSync(sandbox)) {
    fs.unlinkSync(sandbox);
  }

  // Find the Electron binary (the only ELF executable without an extension
  // that isn't chrome_crashpad_handler)
  const entries = fs.readdirSync(appOutDir);
  let execName = null;
  for (const entry of entries) {
    const full = path.join(appOutDir, entry);
    const stat = fs.statSync(full);
    if (!stat.isFile()) continue;
    if (path.extname(entry) !== '') continue;
    if (entry === 'chrome_crashpad_handler') continue;
    // Check if it's an ELF binary (starts with 0x7f ELF)
    const fd = fs.openSync(full, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) {
      execName = entry;
      break;
    }
  }

  if (!execName) {
    console.warn('afterPack: could not find Electron binary in', appOutDir);
    return;
  }
  if (!wrap) {
    writeCliLauncher(path.join(appOutDir, 'resources', 'cli'), 'linux', `../../${execName}`);
    return;
  }

  const binPath = path.join(appOutDir, execName);
  const renamedPath = path.join(appOutDir, `${execName}.bin`);

  fs.renameSync(binPath, renamedPath);
  // ABJECT_DESKTOP_CLI: run the abject command instead of the app. The
  // AppImage's script in ~/.local/bin sets it, since the AppImage's mount
  // path (and so resources/cli) changes on every launch.
  fs.writeFileSync(
    binPath,
    '#!/bin/bash\n'
    + 'if [ -n "$ABJECT_DESKTOP_CLI" ]; then\n'
    + `  ELECTRON_RUN_AS_NODE=1 ABJECT_EDITION=desktop exec "\${BASH_SOURCE%/*}"/${execName}.bin "\${BASH_SOURCE%/*}"/resources/cli/abject.mjs "$@"\n`
    + 'fi\n'
    + `"\${BASH_SOURCE%/*}"/${execName}.bin "$@" --no-sandbox\n`,
    { mode: 0o755 },
  );
  writeCliLauncher(path.join(appOutDir, 'resources', 'cli'), 'linux', `../../${execName}.bin`);

  console.log(`afterPack: wrapped ${execName} with --no-sandbox`);
};
