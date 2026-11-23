import type { AbjectId } from './types.js';
import type { DecisionBasis, GrantReceipt } from './permission-modes.js';

/** Evidence returned by the owner of an operation, never supplied by its caller. */
export interface PermissionReceipt {
  authority: AbjectId;
  callerId?: AbjectId;
  taskId?: string;
  operation: string;
  resource: string;
  decision: string;
  source: 'policy' | 'user' | 'unavailable';
  reason: string;
  project?: string;
  /** What decided: a grant, a rule, a session grant, a floor, the global prompt mode, a preapproval or the person. */
  basis?: DecisionBasis;
  /** The grant that was presented or found, with its chain from the root. */
  grant?: GrantReceipt;
}

export class PermissionDenied extends Error {
  readonly code = 'PERMISSION_DENIED';
  readonly details: { permission: PermissionReceipt };
  /**
   * @param message what the caller is told, when the owner can say it better
   *        than the receipt's reason (e.g. "The person declined: ..."). The
   *        receipt still travels in `details` either way.
   */
  constructor(permission: PermissionReceipt, message?: string) {
    super(message ?? `${permission.reason} (${permission.operation}: ${permission.resource})`);
    this.details = { permission };
  }
}

/**
 * The sentence a caller reads when an outward action was refused: who said no
 * (the person, a rule or setting, or nobody being reachable), then the action.
 * Shared by the objects that ask PermissionBroker before acting, so every
 * refusal reads the same way and an agent can tell a decline from an outage.
 */
export function refusalMessage(permission: PermissionReceipt, action: string): string {
  if (permission.source === 'user') return `The person declined: ${action}`;
  if (permission.source === 'unavailable') return `Nobody could be asked to approve (${permission.reason}): ${action}`;
  return `Not allowed by a permission rule or setting (${permission.reason}): ${action}`;
}

export function errorDetails(error: unknown): unknown {
  return error instanceof Error && 'details' in error ? error.details : undefined;
}
