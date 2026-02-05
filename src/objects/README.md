# src/objects/ - System Objects

System-level objects providing core services. Each is an Abject with a well-defined manifest and message interface.

## Files

### registry.ts

Central directory for object discovery. Multi-indexed by ID, interface, capability, and name.

- **Methods**: `registerObject`, `unregisterObject`, `lookupObject`, `discoverObjects`, `subscribe`, `listObjects`, `getManifest`
- **`DiscoveryQuery`**: filter by name, interface, capability, tags
- **Events**: subscribers notified on register/unregister
- **Well-known ID**: `REGISTRY_ID`

### factory.ts

Object lifecycle management.

- **`spawnInstance(obj)`**: spawn pre-constructed Abject (init on bus, register with Registry)
- **`spawn(request)`**: spawn from manifest + code (constructor-based or WASM)
- **`kill(id)`**: stop and deregister
- **`registerConstructor(name, ctor)`**: register JS constructors for name-based spawning
- **Tracking**: `getAllObjects()`, `getObject(id)`
- **Well-known ID**: `FACTORY_ID`

### llm-object.ts

LLM service wrapper, provider-agnostic.

- **Methods**: `complete`, `generateCode`, `analyze`, `listProviders`, `setProvider`
- **`configure({ anthropicApiKey?, openaiApiKey? })`**: registers providers from API keys
- **Code extraction**: strips markdown code fences from LLM responses
- **Well-known ID**: `LLM_OBJECT_ID`

### object-creator.ts

Create objects from natural language prompts.

- **`create(prompt)`**: discovers existing objects, builds LLM prompt with available interfaces, parses response for JSON manifest + TypeScript code
- **`modify(objectId, prompt)`**: modify existing object, triggers proxy regen
- **`suggest`, `listAvailable`, `getObjectGraph`**: discovery and visualization
- **Well-known ID**: `OBJECT_CREATOR_ID`

### proxy-generator.ts

LLM-generated protocol translation proxies.

- **`generateProxy(sourceId, targetId, sourceManifest, targetManifest)`**: LLM generates proxy code + manifest + agreement
- **`regenerateProxy(agreementId, errorContext)`**: regenerate with error context from previous failures
- **Cache**: stores generated proxies for regeneration
- **Well-known ID**: `PROXY_GENERATOR_ID`

### ui-server.ts

X11-style display server.

- **Surface ownership**: objects own their surfaces, verified on every operation
- **Input routing**: mouse → surface under pointer, keyboard → focused surface
- **Focus management**: focus/blur event notifications
- **Methods**: `createSurface`, `destroySurface`, `draw`, `moveSurface`, `resizeSurface`, `setZIndex`, `focus`, `getDisplayInfo`
- **Well-known ID**: `UI_SERVER_ID`

## Common Pattern

Every object follows the same structure:
1. Constructor defines manifest with full `InterfaceDeclaration`
2. `setupHandlers()` registers `this.on('method', handler)` for each method
3. Dependencies injected via `set*()` methods
4. Well-known ID exported as `const FOO_ID = 'abjects:foo' as AbjectId`

## Subdirectory

See `capabilities/README.md` for the 6 built-in capability objects.
