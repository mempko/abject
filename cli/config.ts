/**
 * The `abject` command's own settings: login tokens it cached per backend
 * URL, and the data directory setup pointed it at.
 *
 * Kept apart from the instance's data directory (the backend owns that), in
 * the OS's per-user config location. Tokens from the old `commune` client are
 * picked up once.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface CliConfig {
  /** Session tokens by gateway URL (7-day logins). */
  tokens: Record<string, string>;
  /** The data directory chosen in setup, when not the OS default. */
  dataDir?: string;
}

/** Where the config lives: per user, per OS convention. */
export function cliConfigPath(): string {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'abject-cli', 'config.json');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'abject-cli', 'config.json');
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), 'abject-cli', 'config.json');
}

/** The old `commune` client's token cache. */
const LEGACY_COMMUNE_CONFIG = path.join(os.homedir(), '.config', 'abjects', 'commune.json');

export function loadCliConfig(): CliConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(cliConfigPath(), 'utf8')) as Partial<CliConfig>;
    return { tokens: parsed.tokens ?? {}, ...(parsed.dataDir ? { dataDir: parsed.dataDir } : {}) };
  } catch {
    // First run: carry over commune's cached logins.
    try {
      const legacy = JSON.parse(fs.readFileSync(LEGACY_COMMUNE_CONFIG, 'utf8')) as { tokens?: Record<string, string> };
      return { tokens: legacy.tokens ?? {} };
    } catch {
      return { tokens: {} };
    }
  }
}

export function saveCliConfig(update: Partial<CliConfig>): void {
  const next = { ...loadCliConfig(), ...update };
  const file = cliConfigPath();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  } catch { /* the cache is best-effort */ }
}

export function saveToken(url: string, token: string): void {
  const config = loadCliConfig();
  saveCliConfig({ tokens: { ...config.tokens, [url]: token } });
}
