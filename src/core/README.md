# src/core/ - Core Foundation

Defines the foundational types, contracts, and abstractions that every other module depends on. This is the bottom of the dependency graph.

## Files

### types.ts

All type definitions for the system:

- **Identity types**: `AbjectId`, `InterfaceId`, `MessageId`, `AgreementId`, `CapabilityId`
- **Messages**: `AbjectMessage<T>`, `MessageHeader`, `MessageRouting`, `MessageProtocol`, `MessageType`
- **Interfaces**: `InterfaceDeclaration`, `MethodDeclaration`, `ParameterDeclaration`, `TypeDeclaration`, `EventDeclaration`
- **Capabilities**: `CapabilityRequest`, `CapabilityGrant`, `CapabilityRestriction`
- **Manifest**: `AbjectManifest` (name, description, version, interfaces, required/provided capabilities, tags)
- **Protocol**: `ProtocolAgreement`, `ProtocolBinding`, `MessageTransformation`
- **State**: `AbjectState` (`initializing` | `ready` | `busy` | `error` | `stopped`), `AbjectStatus`
- **Registry/Factory**: `ObjectRegistration`, `DiscoveryQuery`, `SpawnRequest`, `SpawnResult`
- **WASM**: `WasmObjectExports`, `WasmImports`

### contracts.ts

Design-by-contract assertions. **Always enabled** - correctness over performance.

- `require(condition, message)` - Precondition check
- `ensure(condition, message)` - Postcondition check
- `invariant(condition, message)` - Class invariant check
- `requireDefined(value, message)` - Non-null assertion with type narrowing
- `requireNonEmpty(value, name)` - Non-empty string
- `requireNonEmptyArray(value, name)` - Non-empty array
- `requirePositive(value, name)` - Positive number
- `requireNonNegative(value, name)` - Non-negative number

All throw `ContractViolation` with type discrimination.

### message.ts

Message factory functions and utilities:

- **Builders**: `request()`, `reply()`, `event()`, `error()`, `errorFromException()`
- **Type guards**: `isRequest()`, `isReply()`, `isEvent()`, `isError()`, `isReplyTo()`
- **Serialization**: `serialize()`, `deserialize()`
- **Sequence tracking**: Per-sender sequence numbers (module-level Map), `resetSequence()` for tests
- **Constants**: `PROTOCOL_VERSION = '1.0.0'`

### abject.ts

Abstract base class for all objects in the system.

- **`Abject`**: UUID identity, manifest, `CapabilitySet`, state machine
  - Handler registration: `on(method, handler)`, wildcard `'*'` handler
  - Sending: `send()` (fire-and-forget), `request<T>()` (with 30s timeout, returns Promise)
  - Pending reply tracking: maps messageId → { resolve, reject, timeout }
  - Lifecycle: `init(bus)` registers with MessageBus, `stop()` rejects pending replies
  - Hooks: override `onInit()`, `onStop()`, `checkInvariants()`
  - Auto-reply: returning a value from a request handler auto-sends reply

- **`SimpleAbject`**: Convenience class - create objects with inline handlers dict + name, no subclassing needed

### capability.ts

Capability constants and management:

- `Capabilities` object: all standard capability ID strings
- `CapabilitySet`: `has()`, `get()`, `add()`, `remove()`, `all()`, `satisfies()`, `missing()`
- `requestCapability()`, `grantCapability()` helper constructors
- `getDefaultCapabilities(objectId)`: returns SEND_MESSAGE, LOG, TIME grants

### identity.ts

P2P identity layer with cryptographic primitives.

- **`PeerId`**: hex SHA-256 of SPKI public key (unique peer identifier)
- **Key serialization**: JWK format for signing and exchange keys
- **Key import**: `importExchangePublicKey()`, `importSigningPublicKey()` from JWK
- **Peer ID derivation**: `derivePeerIdFromJwk()` computes PeerId from a public key
- **Session keys**: `deriveSessionKey()` via ECDH key agreement
- **Encryption**: `aesEncrypt()` / `aesDecrypt()` using AES-256-GCM

### introspect.ts

Introspection protocol for LLM-readable object self-description.

- **`IntrospectResult`**: structured description of an object's capabilities
- **`INTROSPECT_METHODS`**: array of built-in method declarations (the `describe` handler added to every Abject)
- **`formatManifestAsDescription(manifest)`**: converts an `AbjectManifest` into plain English, including interfaces, methods with parameters and return types, events, and capabilities

Used by `ObjectCreator`, `ProxyGenerator`, and `Negotiator` to learn what objects can do without hardcoded knowledge.

## Key Pattern

Every object extends `Abject`, defines a manifest with `InterfaceDeclaration`s, registers message handlers via `on()`, and uses contracts pervasively.
