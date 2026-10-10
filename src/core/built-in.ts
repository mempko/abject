/**
 * Which objects the system trusts: built-in ones.
 *
 * A built-in object is an instance of a class compiled into the server (a
 * registered constructor). Everything else runs code the system did not
 * ship: a ScriptableAbject's handler map (often written by a model), a WASM
 * module, an Organism's spec, an installed package, a proxy, or an object a
 * remote peer owns. Those register with their `source` (or the package
 * owner, or the remote peer), and nothing they can send changes that:
 *
 * - The Factory spawns a registered constructor only for a built-in
 *   requester, so code that is not built-in cannot make a built-in instance
 *   under a name of its choosing.
 * - The registries take writes to another object's entry only from built-in
 *   senders; an object updating its own entry keeps its name, typeId, owner
 *   and source.
 *
 * So the registration is the proof: no source, no package owner, no remote
 * peer means the code is ours. Privileged requests (settings writes, secret
 * reads, the web gateway's controls) are admitted by that, together with the
 * caller's registered name.
 */

import type { ObjectRegistration } from './types.js';
import { isPackageOwner } from './packages.js';

/** The sender id the bootstrap uses before any object exists to speak for it. */
export const BOOTSTRAP_SENDER_ID = 'bootstrap';

/** Whether a registration describes an instance of a class compiled into the server. */
export function isBuiltInRegistration(
  reg: Pick<ObjectRegistration, 'source' | 'owner' | 'ownerPeerId'> | null | undefined,
): boolean {
  return !!reg && !reg.source && !isPackageOwner(reg.owner) && !reg.ownerPeerId;
}
