/**
 * The Abject release this server runs.
 *
 * The compiled server has it baked in at build time (build-server.mjs
 * defines __ABJECT_VERSION__ from package.json); a source run reads
 * package.json beside the server directory.
 */

import * as fs from 'node:fs';

declare const __ABJECT_VERSION__: string | undefined;

let cached: string | undefined;

export function abjectVersion(): string {
  if (cached) return cached;
  if (typeof __ABJECT_VERSION__ === 'string' && __ABJECT_VERSION__) return (cached = __ABJECT_VERSION__);
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    cached = typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
