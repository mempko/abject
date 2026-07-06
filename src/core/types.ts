/**
 * Core type definitions for the Abjects system.
 */

// =============================================================================
// Identity Types
// =============================================================================

export type AbjectId = string;
export type InterfaceId = string;
export type MessageId = string;
export type AgreementId = string;
export type CapabilityId = string;
export type PeerId = string;
export type TypeId = string;

// =============================================================================
// Message Types
// =============================================================================

export type MessageType = 'request' | 'reply' | 'event' | 'error';

export interface MessageHeader {
  messageId: MessageId;
  correlationId?: MessageId;
  sequenceNumber: number;
  timestamp: number;
  type: MessageType;
}

export interface MessageRouting {
  from: AbjectId;
  to: AbjectId;
  method?: string;
}

export interface MessageProtocol {
  version: string;
  negotiationId?: AgreementId;
}

export interface AbjectMessage<T = unknown> {
  header: MessageHeader;
  routing: MessageRouting;
  payload: T;
  protocol: MessageProtocol;
}

// =============================================================================
// Error Types
// =============================================================================

export interface AbjectError {
  code: string;
  message: string;
  details?: unknown;
  stack?: string;
}

export type ErrorMessage = AbjectMessage<AbjectError>;

// =============================================================================
// Interface Declaration
// =============================================================================

export interface MethodDeclaration {
  name: string;
  description: string;
  parameters: ParameterDeclaration[];
  returns?: TypeDeclaration;
}

export interface ParameterDeclaration {
  name: string;
  type: TypeDeclaration;
  description: string;
  optional?: boolean;
}

export interface TypeDeclaration {
  kind: 'primitive' | 'array' | 'object' | 'union' | 'reference';
  primitive?: 'string' | 'number' | 'boolean' | 'null' | 'undefined';
  elementType?: TypeDeclaration;
  properties?: Record<string, TypeDeclaration>;
  variants?: TypeDeclaration[];
  reference?: string;
}

export interface InterfaceDeclaration {
  id: InterfaceId;
  name: string;
  description: string;
  methods: MethodDeclaration[];
  events?: EventDeclaration[];
}

export interface EventDeclaration {
  name: string;
  description: string;
  payload: TypeDeclaration;
}

// =============================================================================
// Capability Types
// =============================================================================

export interface CapabilityRequest {
  capability: CapabilityId;
  reason: string;
  required: boolean;
}

export interface CapabilityGrant {
  capability: CapabilityId;
  objectId: AbjectId;
  restrictions?: CapabilityRestriction[];
}

export interface CapabilityRestriction {
  type: string;
  config: unknown;
}

// =============================================================================
// Object Manifest
// =============================================================================

export interface AbjectManifest {
  name: string;
  description: string;
  version: string;
  interface: InterfaceDeclaration;
  requiredCapabilities: CapabilityRequest[];
  providedCapabilities?: CapabilityId[];
  tags?: string[];
  /**
   * Optional display glyph (a single emoji or character) shown next to the
   * object's name in launchers like the Abjects rail. Objects without one fall
   * back to a default icon, so older manifests keep working unchanged.
   */
  icon?: string;
  /**
   * Prototype lineage. Instances are prototypes (Self-style): cloning a live
   * object records where the copy came from and how many clone hops separate
   * it from its original ancestor. Absent on objects that were never cloned.
   */
  lineage?: {
    /** typeId (preferred) or AbjectId of the object this was cloned from. */
    clonedFrom: string;
    /** 1 for a clone of an original, parent.generation + 1 otherwise. */
    generation: number;
  };
}

// =============================================================================
// Protocol Agreement
// =============================================================================

export interface MessageTransformation {
  sourceMethod: string;
  targetMethod: string;
  payloadTransform?: string;
}

export interface ProtocolBinding {
  participantId: AbjectId;
  transformations: MessageTransformation[];
}

export interface ProtocolAgreement {
  agreementId: AgreementId;
  participants: [AbjectId, AbjectId];
  proxyId?: AbjectId;
  protocol: {
    version: string;
    bindings: Record<AbjectId, MessageTransformation[]>;
  };
  healthCheckInterval: number;
  createdAt: number;
  expiresAt?: number;
}

// =============================================================================
// Object State
// =============================================================================

export type AbjectState = 'initializing' | 'ready' | 'busy' | 'error' | 'stopped';

export interface AbjectStatus {
  id: AbjectId;
  typeId?: TypeId;
  state: AbjectState;
  manifest: AbjectManifest;
  connections: AbjectId[];
  errorCount: number;
  lastError?: AbjectError;
  startedAt: number;
  lastActivity: number;
}

// =============================================================================
// Registry Types
// =============================================================================

export interface ObjectRegistration {
  id: AbjectId;
  typeId?: TypeId;
  name: string;
  manifest: AbjectManifest;
  status: AbjectStatus;
  registeredAt: number;
  owner?: AbjectId;
  source?: string;
  data?: Record<string, unknown>;
}

/**
 * Lightweight registration summary. Exists so LLM-driven agents can browse
 * the registry without pulling every method's parameter/return schema —
 * those full manifests are recovered on demand via lookup(id).
 */
export interface ObjectSummary {
  id: AbjectId;
  typeId?: TypeId;
  name: string;
  description: string;
  methods: string[];
  tags?: string[];
}

export interface DiscoveryQuery {
  name?: string;
  interface?: InterfaceId;
  capability?: CapabilityId;
  tags?: string[];
}

// =============================================================================
// Factory Types
// =============================================================================

export interface SpawnRequest {
  manifest: AbjectManifest;
  /** Raw WASM module bytes; hashed into the module store at spawn time. */
  code?: ArrayBuffer;
  /** WASM module bytes as base64 — the message-passing-friendly form of `code`. */
  codeBase64?: string;
  /**
   * Behavior source. JS handler-map source for ScriptableAbjects, a JSON
   * OrganismSpec for Organisms (with the 'organism' tag), or a wasm source
   * ref (`wasm:sha256:<hex>`) for WasmAbjects.
   */
  source?: string;
  owner?: AbjectId;
  initialState?: unknown;
  grantedCapabilities?: CapabilityGrant[];
  parentId?: AbjectId;
  skipGlobalRegistry?: boolean;
  constructorArgs?: unknown;
  registryHint?: AbjectId;
  typeId?: TypeId;
  data?: Record<string, unknown>;
}

export interface SpawnResult {
  objectId: AbjectId;
  typeId?: TypeId;
  status: AbjectStatus;
}

// WASM abject ABI types live in src/sandbox/wasm-abi.ts (see docs/WASM_ABI.md).
