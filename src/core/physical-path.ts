import * as nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const fs: typeof nodeFs.promises = (process.versions.electron
  ? createRequire(import.meta.url)('original-fs') : nodeFs).promises;

/** Unresolvable grants confer no access; they must not poison unrelated grants.
 * Use physicalPath directly for requested destinations so their errors still fail.
 */
export async function physicalGrantRoots(roots: readonly string[]): Promise<string[]> {
  const results = await Promise.allSettled(roots.map(root => physicalPath(root)));
  return results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
}

/** Resolve existing ancestors too, so a new file cannot escape through a symlink. */
export async function physicalPath(input: string, depth = 0): Promise<string> {
  if (depth > 40) throw Object.assign(new Error('Too many symbolic links'), { code: 'ELOOP' });
  const absolute = path.resolve(input);
  try { return await fs.realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    // A dangling symlink is not a missing file: resolve its target explicitly.
    try { return physicalPath(path.resolve(parent, await fs.readlink(absolute)), depth + 1); }
    catch (linkError) {
      if (!['ENOENT', 'EINVAL'].includes((linkError as NodeJS.ErrnoException).code ?? '')) throw linkError;
    }
    return path.join(await physicalPath(parent, depth), path.basename(absolute));
  }
}
