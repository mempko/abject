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
  manifest: AbjectManifest;
  status: AbjectStatus;
  registeredAt: number;
  owner?: AbjectId;
  source?: string;
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
  code?: ArrayBuffer;
  source?: string;
  owner?: AbjectId;
  initialState?: unknown;
  grantedCapabilities?: CapabilityGrant[];
  parentId?: AbjectId;
  skipGlobalRegistry?: boolean;
  constructorArgs?: unknown;
  registryHint?: AbjectId;
}

export interface SpawnResult {
  objectId: AbjectId;
  status: AbjectStatus;
}

// =============================================================================
// WASM Types
// =============================================================================

export interface WasmObjectExports {
  init: (statePtr: number, stateLen: number) => void;
  handle: (msgPtr: number, msgLen: number) => number;
  manifest: () => number;
  memory: WebAssembly.Memory;
  alloc?: (size: number) => number;
  dealloc?: (ptr: number, size: number) => void;
}

export interface WasmImports {
  abjects: {
    send: (msgPtr: number, msgLen: number) => void;
    log: (level: number, msgPtr: number, msgLen: number) => void;
    get_time: () => number;
  };
}
