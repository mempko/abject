/**
 * Where an installed Abject keeps its data, by operating system.
 *
 * The desktop app and the headless server use the same directory by default,
 * so one person's workspaces are the same whichever of them is running. A
 * source checkout (`pnpm awaken`) keeps using `.abjects` in the checkout; only
 * installed builds default here. ABJECTS_DATA_DIR overrides it everywhere.
 *
 * Plain functions, no Abject: the desktop launcher, the headless launcher and
 * the `abject` command all need the answer before any object exists.
 */

import * as os from 'node:os';
import * as path from 'node:path';

/** The OS-standard data directory for an installed Abject. */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const home = os.homedir();
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'abject');
  if (platform === 'win32') return path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'abject');
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'abject');
}

/** The data directory in force: ABJECTS_DATA_DIR when set, else the OS default. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ABJECTS_DATA_DIR?.trim();
  return explicit ? path.resolve(explicit) : defaultDataDir(env);
}
