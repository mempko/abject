import type { AbjectId } from './types.js';

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
}

export class PermissionDenied extends Error {
  readonly code = 'PERMISSION_DENIED';
  readonly details: { permission: PermissionReceipt };
  constructor(permission: PermissionReceipt) {
    super(`${permission.reason} (${permission.operation}: ${permission.resource})`);
    this.details = { permission };
  }
}

export function errorDetails(error: unknown): unknown {
  return error instanceof Error && 'details' in error ? error.details : undefined;
}
