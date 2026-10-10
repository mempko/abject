/**
 * Package ownership — how an abject that came from an installed package is
 * told apart from one a person or an agent made.
 *
 * A package's abjects, script or WASM, are spawned with the owner
 * `package:<name>`. That one marker is enough for every part of the system
 * that must treat them differently, and it survives respawn, worker recovery
 * and restart because the owner rides the Registry registration:
 *
 * - ScriptableAbject refuses source and manifest edits: the code comes from
 *   the installed package, so an edit here would be silently undone by the
 *   next upgrade. Change the package and reinstall it instead.
 * - AbjectStore keeps their data (a script's saveData, a WASM module's
 *   persist) under `package/<TypeName>` and never restores them as user
 *   objects (WorkspaceManager spawns them from the package, handing that
 *   data back). At system scope the Packages service keeps it instead.
 * - Packages answers `getSettings` to them for their own package.
 * - Factory.clone / instantiate drop the marker, so a copy of a package
 *   abject is an ordinary, editable user object.
 */

import type { AbjectId } from './types.js';

export const PACKAGE_OWNER_PREFIX = 'package:';

/** The owner a package's abjects are spawned with. */
export function packageOwner(packageName: string): AbjectId {
  return `${PACKAGE_OWNER_PREFIX}${packageName}` as AbjectId;
}

/** Whether an owner marks an abject as coming from an installed package. */
export function isPackageOwner(owner: unknown): owner is string {
  return typeof owner === 'string' && owner.startsWith(PACKAGE_OWNER_PREFIX)
    && owner.length > PACKAGE_OWNER_PREFIX.length;
}

/** The package name inside a package owner, or undefined for any other owner. */
export function packageNameOf(owner: unknown): string | undefined {
  return isPackageOwner(owner) ? owner.slice(PACKAGE_OWNER_PREFIX.length) : undefined;
}

/** AbjectStore key for a package abject's durable data in one workspace. */
export function packageDataKey(typeName: string): string {
  return `package/${typeName}`;
}
