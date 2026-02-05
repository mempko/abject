# Abjects: LLM-Mediated Object System

A distributed object system where objects communicate via message passing, negotiate protocols using an LLM, and self-heal when communication breaks down.

## Core Concepts

- **Abject** - Self-describing object with state, behavior, and manifest
- **Message Passing** - Async messages with request/reply/event/error types
- **Protocol Mediation** - LLM generates proxy objects that translate between incompatible interfaces
- **Self-Healing** - Objects detect incomprehension, LLM regenerates proxies automatically
- **Everything is an Object** - Registry, Factory, LLM, UI, proxies are all objects
- **Object Creator** - Create objects via natural language prompts

## Tech Stack

- **Runtime**: TypeScript
- **Build**: Vite
- **Object Virtualization**: WASM (sandboxed execution)
- **Network**: WebSocket
- **UI**: Canvas-based compositor (X11-style)
- **LLM**: Provider-agnostic (Claude, OpenAI, Ollama)

## Quick Start

```bash
# Install dependencies
pnpm install

# Start development server
pnpm dev

# Build for production
pnpm build

# Run tests
pnpm exec playwright install
pnpm test
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Browser Main Thread                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌───────────────┐  │
│  │ Message  │ │ Network  │ │   LLM    │ │ UI Compositor │  │
│  │   Bus    │ │  Layer   │ │ Gateway  │ │   (Canvas)    │  │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └───────┬───────┘  │
└───────┼────────────┼────────────┼───────────────┼──────────┘
        │      postMessage API    │               │
┌───────┼────────────┼────────────┼───────────────┼──────────┐
│       ▼            ▼            ▼               ▼          │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              Object Runtime Worker                   │   │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐  │   │
│  │  │ Registry │ │ Factory  │ │ LLM Obj  │ │ UI Obj │  │   │
│  │  └──────────┘ └──────────┘ └──────────┘ └────────┘  │   │
│  │  ┌──────────────────────────────────────────────┐   │   │
│  │  │      User Objects (WASM Modules)             │   │   │
│  │  └──────────────────────────────────────────────┘   │   │
│  └─────────────────────────────────────────────────────┘   │
│                      Web Worker                             │
└─────────────────────────────────────────────────────────────┘
```

## Design Principles

### Design by Contract

Every function uses preconditions, postconditions, and invariants:

```typescript
function send(message: AbjectMessage): void {
  // Preconditions
  require(message.header.messageId !== '', 'messageId must not be empty');
  require(message.routing.to !== '', 'recipient must be specified');

  // ... implementation ...

  // Postconditions
  ensure(this.messageCount > oldMessageCount, 'message count must increase');
}
```

### LLM-Generated Proxies

When Object A wants to talk to Object B with incompatible interfaces:

```
┌──────────┐     ┌─────────────────┐     ┌──────────┐
│ Object A │────►│  Proxy Object   │────►│ Object B │
│          │◄────│ (LLM-generated) │◄────│          │
└──────────┘     └─────────────────┘     └──────────┘
```

The proxy is a real object with a manifest, using the same message protocol.

### Self-Healing

- Error rate > 10% triggers proxy regeneration
- Unknown message types trigger renegotiation
- Hot-swap proxies without disrupting objects

## Capability Objects

Built-in objects that provide system capabilities:

| Object | Description |
|--------|-------------|
| **HttpClient** | HTTP requests |
| **Storage** | Persistent key-value (IndexedDB) |
| **Timer** | Scheduling and delays |
| **Clipboard** | System clipboard access |
| **Console** | Debug logging |
| **FileSystem** | Virtual filesystem |

## Configuration

Set LLM API keys as global variables before loading:

```html
<script>
  window.ANTHROPIC_API_KEY = 'your-key';
  // or
  window.OPENAI_API_KEY = 'your-key';
</script>
```

For local LLM, run Ollama on localhost:11434.

## License

GPL-3.0-or-later - See [LICENSE](LICENSE) for details.
