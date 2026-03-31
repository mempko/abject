/**
 * electron-builder afterPack hook for Linux.
 *
 * Renames the real Electron binary to .bin and replaces it with a shell
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

module.exports = async function afterPack({ targets, appOutDir }) {
  // Only apply to Linux targets
  if (!targets.find(t => /AppImage|snap|deb|rpm|freebsd|pacman/i.test(t.name))) return;

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

  const binPath = path.join(appOutDir, execName);
  const renamedPath = path.join(appOutDir, `${execName}.bin`);

  fs.renameSync(binPath, renamedPath);
  fs.writeFileSync(
    binPath,
    `#!/bin/bash\n"\${BASH_SOURCE%/*}"/${execName}.bin "$@" --no-sandbox\n`,
    { mode: 0o755 },
  );

  console.log(`afterPack: wrapped ${execName} with --no-sandbox`);
};
