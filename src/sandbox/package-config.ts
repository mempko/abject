/**
 * Package configuration — which packages load, from where, and with what
 * settings.
 *
 * Lives in one file, `$ABJECTS_DATA_DIR/packages.json`, so the same instance
 * can be configured by hand, by provisioning tooling, or through the
 * Packages tab of the system settings (the Packages abject writes it):
 *
 *   {
 *     "dirs": ["/opt/acme/packages"],      // extra package directories
 *     "disabled": ["SceneShowcase"],       // package names that must not load
 *     "settings": {                        // per-package settings values
 *       "Tally": { "label": "Visits" }
 *     }
 *   }
 *
 * `ABJECTS_PACKAGE_DIRS` (path-delimiter separated) adds directories from the
 * environment; those are not editable from the UI.
 *
 * The file is read synchronously at boot, before anything spawns, and written
 * atomically with owner-only permissions because settings may hold secrets.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Log } from '../core/timed-log.js';

const log = new Log('PACKAGES');

export type PackageSettingValue = string | number | boolean;

export interface PackageConfig {
  /** Extra package directories added by the user (absolute paths). */
  dirs: string[];
  /** Package names that are installed but must not load. */
  disabled: string[];
  /** Settings values per package name. */
  settings: Record<string, Record<string, PackageSettingValue>>;
}

export function emptyPackageConfig(): PackageConfig {
  return { dirs: [], disabled: [], settings: {} };
}

/** Where the configuration file lives for this instance. */
export function packageConfigPath(): string {
  const dataDir = process.env.ABJECTS_DATA_DIR ?? '.abjects';
  return path.resolve(dataDir, 'packages.json');
}

/** Package directories named by the environment (`ABJECTS_PACKAGE_DIRS`). */
export function envPackageDirs(): string[] {
  const raw = process.env.ABJECTS_PACKAGE_DIRS ?? '';
  return raw.split(path.delimiter).map(s => s.trim()).filter(Boolean).map(d => path.resolve(d));
}

function isSettingValue(v: unknown): v is PackageSettingValue {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/**
 * Coerce whatever is on disk into a PackageConfig. Unknown or malformed
 * fields are dropped rather than failing the boot: a broken settings file
 * must never stop the instance from starting.
 */
export function normalizePackageConfig(raw: unknown): PackageConfig {
  const cfg = emptyPackageConfig();
  if (!raw || typeof raw !== 'object') return cfg;
  const r = raw as Record<string, unknown>;
  if (Array.isArray(r.dirs)) {
    cfg.dirs = [...new Set(r.dirs.filter((d): d is string => typeof d === 'string' && d.trim() !== '')
      .map(d => path.resolve(d)))];
  }
  if (Array.isArray(r.disabled)) {
    cfg.disabled = [...new Set(r.disabled.filter((n): n is string => typeof n === 'string' && n !== ''))];
  }
  if (r.settings && typeof r.settings === 'object') {
    for (const [pkg, values] of Object.entries(r.settings as Record<string, unknown>)) {
      if (!values || typeof values !== 'object') continue;
      const clean: Record<string, PackageSettingValue> = {};
      for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
        if (isSettingValue(v)) clean[k] = v;
      }
      cfg.settings[pkg] = clean;
    }
  }
  return cfg;
}

/** Read the configuration file. A missing or unreadable file means defaults. */
export function readPackageConfig(file: string = packageConfigPath()): PackageConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return emptyPackageConfig();
  }
  try {
    return normalizePackageConfig(JSON.parse(text));
  } catch (err) {
    log.warn(`ignoring malformed ${file}: ${err instanceof Error ? err.message : err}`);
    return emptyPackageConfig();
  }
}

/** Write the configuration file atomically, readable only by its owner. */
export function writePackageConfig(cfg: PackageConfig, file: string = packageConfigPath()): void {
  const clean = normalizePackageConfig(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* not supported on this filesystem */ }
}
