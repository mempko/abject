/**
 * Capability types and helpers.
 */

import { CapabilityId, CapabilityGrant, CapabilityRequest } from './types.js';
import { require } from './contracts.js';

// =============================================================================
// Standard Capabilities
// =============================================================================

export const Capabilities = {
  // Core capabilities
  SEND_MESSAGE: 'abjects:send' as CapabilityId,
  LOG: 'abjects:log' as CapabilityId,
  TIME: 'abjects:time' as CapabilityId,

  // System capabilities
  REGISTRY_READ: 'abjects:registry:read' as CapabilityId,
  REGISTRY_WRITE: 'abjects:registry:write' as CapabilityId,
  FACTORY_SPAWN: 'abjects:factory:spawn' as CapabilityId,
  LLM_QUERY: 'abjects:llm:query' as CapabilityId,

  // UI capabilities
  UI_SURFACE: 'abjects:ui:surface' as CapabilityId,
  UI_INPUT: 'abjects:ui:input' as CapabilityId,

  // External capabilities
  HTTP_REQUEST: 'abjects:http:request' as CapabilityId,
  STORAGE_READ: 'abjects:storage:read' as CapabilityId,
  STORAGE_WRITE: 'abjects:storage:write' as CapabilityId,
  TIMER: 'abjects:timer' as CapabilityId,
  CLIPBOARD_READ: 'abjects:clipboard:read' as CapabilityId,
  CLIPBOARD_WRITE: 'abjects:clipboard:write' as CapabilityId,
  FILESYSTEM_READ: 'abjects:filesystem:read' as CapabilityId,
  FILESYSTEM_WRITE: 'abjects:filesystem:write' as CapabilityId,
  CONSOLE: 'abjects:console' as CapabilityId,
  EDIT_OBJECT: 'abjects:object:edit' as CapabilityId,
  WEB_PARSE: 'abjects:web:parse' as CapabilityId,
  WEB_BROWSE: 'abjects:web:browse' as CapabilityId,

  // Identity capabilities
  IDENTITY_SIGN: 'abjects:identity:sign' as CapabilityId,
  IDENTITY_VERIFY: 'abjects:identity:verify' as CapabilityId,

  // Peer capabilities
  PEER_CONNECT: 'abjects:peer:connect' as CapabilityId,
  PEER_DISCOVER: 'abjects:peer:discover' as CapabilityId,

  // Shared state capabilities
  SHARED_STATE: 'abjects:shared-state' as CapabilityId,

  // File transfer capabilities
  FILE_TRANSFER_SEND: 'abjects:file-transfer:send' as CapabilityId,
  FILE_TRANSFER_RECEIVE: 'abjects:file-transfer:receive' as CapabilityId,

  // Media stream capabilities
  MEDIA_STREAM: 'abjects:media-stream' as CapabilityId,

  // Agent capabilities
  WEB_AGENT: 'abjects:web-agent' as CapabilityId,

  // Coordination capabilities
  TUPLE_SPACE: 'abjects:tuple-space' as CapabilityId,

  // Host capabilities (real filesystem, shell, web)
  SHELL_EXECUTE: 'abjects:shell:execute' as CapabilityId,
  HOSTFS_READ: 'abjects:hostfs:read' as CapabilityId,
  HOSTFS_WRITE: 'abjects:hostfs:write' as CapabilityId,
  WEB_SEARCH: 'abjects:web:search' as CapabilityId,
  WEB_FETCH: 'abjects:web:fetch' as CapabilityId,

  // Skill management
  SKILL_MANAGE: 'abjects:skill:manage' as CapabilityId,
} as const;

// =============================================================================
// Capability Set
// =============================================================================

export class CapabilitySet {
  private grants: Map<CapabilityId, CapabilityGrant> = new Map();

  constructor(grants: CapabilityGrant[] = []) {
    for (const grant of grants) {
      this.grants.set(grant.capability, grant);
    }
  }

  /**
   * Check if a capability is granted.
   */
  has(capability: CapabilityId): boolean {
    return this.grants.has(capability);
  }

  /**
   * Get a capability grant.
   */
  get(capability: CapabilityId): CapabilityGrant | undefined {
    return this.grants.get(capability);
  }

  /**
   * Add a capability grant.
   */
  add(grant: CapabilityGrant): void {
    this.grants.set(grant.capability, grant);
  }

  /**
   * Remove a capability.
   */
  remove(capability: CapabilityId): void {
    this.grants.delete(capability);
  }

  /**
   * Get all granted capabilities.
   */
  all(): CapabilityGrant[] {
    return Array.from(this.grants.values());
  }

  /**
   * Check if all required capabilities are present.
   */
  satisfies(requests: CapabilityRequest[]): boolean {
    for (const req of requests) {
      if (req.required && !this.has(req.capability)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get missing required capabilities.
   */
  missing(requests: CapabilityRequest[]): CapabilityRequest[] {
    return requests.filter(
      (req) => req.required && !this.has(req.capability)
    );
  }
}

// =============================================================================
// Capability Helpers
// =============================================================================

/**
 * Create a capability request.
 */
export function requestCapability(
  capability: CapabilityId,
  reason: string,
  required = true
): CapabilityRequest {
  require(capability !== '', 'capability must not be empty');
  require(reason !== '', 'reason must not be empty');

  return {
    capability,
    reason,
    required,
  };
}

/**
 * Create a capability grant.
 */
export function grantCapability(
  capability: CapabilityId,
  objectId: string
): CapabilityGrant {
  require(capability !== '', 'capability must not be empty');
  require(objectId !== '', 'objectId must not be empty');

  return {
    capability,
    objectId,
  };
}

/**
 * Get the default capabilities granted to all objects.
 */
export function getDefaultCapabilities(objectId: string): CapabilityGrant[] {
  return [
    grantCapability(Capabilities.SEND_MESSAGE, objectId),
    grantCapability(Capabilities.LOG, objectId),
    grantCapability(Capabilities.TIME, objectId),
  ];
}
