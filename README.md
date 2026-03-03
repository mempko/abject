# Abjects: LLM-Mediated Object System

A distributed object system where objects communicate via message passing, negotiate protocols using an LLM, and self-heal when communication breaks down.

## Core Concepts

- **Abject** - Self-describing object with state, behavior, and manifest
- **Message Passing** - Async messages with request/reply/event/error types
- **Protocol Mediation** - LLM generates proxy objects that translate between incompatible interfaces
- **Self-Healing** - Objects detect incomprehension, LLM regenerates proxies automatically
- **Everything is an Object** - Registry, Factory, LLM, UI, proxies are all objects
- **Object Creator** - Create objects via natural language prompts
- **Agents** - Autonomous task execution via observe→think→act loop (AgentAbject)
- **Workspaces** - Isolated, shareable object environments with per-workspace services
- **Widgets** - Canvas-based UI toolkit (~20 widgets: buttons, text inputs, layouts, windows)
- **P2P Identity** - ECDSA/ECDH cryptographic identity, WebRTC encrypted peer channels
- **Supervision** - Erlang-style restart strategies for fault tolerance

## Tech Stack

- **Runtime**: TypeScript
- **Build**: Vite
- **Object Virtualization**: WASM (sandboxed execution)
- **Network**: WebSocket
- **UI**: Canvas-based compositor (X11-style)
- **LLM**: Provider-agnostic (Claude, OpenAI, Ollama)
- **P2P**: WebRTC (browser-native + node-datachannel polyfill)
- **Browser Automation**: Playwright (server-only headless browser capability)
- **Crypto**: Web Crypto API (ECDSA P-256, ECDH, AES-256-GCM)

## Quick Start

```bash
# Install dependencies
pnpm install

# Browser-only mode (everything in-browser)
pnpm dev

# Server/client mode (Node.js backend + thin browser client)
pnpm serve           # Start Node.js backend
pnpm client          # Start thin browser client

# P2P signaling server
pnpm signal          # Start signaling server (:7720)

# Build and test
pnpm build
pnpm exec playwright install   # First time only
pnpm test
```

## Architecture

```
 ┌─ Browser-Only Mode ──────────────────────────────────────────────────┐
 │                                                                      │
 │  ┌─────────────────── MessageBus ──────────────────┐                 │
 │  │  Interceptor Pipeline:                          │                 │
 │  │  HealthInterceptor → NetworkBridge → Delivery   │                 │
 │  └──────────┬──────────────┬───────────────┬───────┘                 │
 │             │              │               │                         │
 │  ┌──────────▼──┐ ┌────────▼─────┐ ┌───────▼────────┐               │
 │  │  Registry   │ │   Factory    │ │  LLM Object    │               │
 │  │  Negotiator │ │ ProxyGen     │ │  ObjectCreator │               │
 │  │  Supervisor │ │ AgentAbject  │ │  HealthMonitor │               │
 │  └─────────────┘ └──────────────┘ └────────────────┘               │
 │             │              │               │                         │
 │  ┌──────────▼──────────────▼───────────────▼────────┐               │
 │  │            Worker Pool (WorkerBridge)             │               │
 │  │  ┌─────────┐ ┌─────────┐ ┌─────────┐            │               │
 │  │  │Worker 1 │ │Worker 2 │ │Worker N │ ...        │               │
 │  │  │(WASM)   │ │(WASM)   │ │(WASM)   │            │               │
 │  │  └─────────┘ └─────────┘ └─────────┘            │               │
 │  └──────────────────────────────────────────────────┘               │
 │                                                                      │
 │  ┌──────── UI ──────────┐  ┌──────── P2P ───────────────────────┐   │
 │  │ Compositor (Canvas)  │  │ PeerTransport ←→ Signaling Server  │   │
 │  │ Widget Toolkit       │  │ IdentityObject (ECDSA/ECDH)       │   │
 │  │ Window Manager       │  │ PeerRegistry / RemoteRegistry     │   │
 │  └──────────────────────┘  └────────────────────────────────────┘   │
 └──────────────────────────────────────────────────────────────────────┘

 ┌─ Server/Client Mode ────────────────────────────────────────────────┐
 │                                                                      │
 │  Node.js Backend (pnpm serve)        Thin Browser Client (pnpm client)
 │  ┌──────────────────────────┐        ┌─────────────────────────┐    │
 │  │ All Abjects + Worker Pool│◄──────►│ FrontendClient          │    │
 │  │ BackendUI (headless)     │  WS    │ Compositor (Canvas)     │    │
 │  │ WebBrowser (Playwright)  │ :7719  │ Input handling          │    │
 │  │ WebParser (linkedom)     │        └─────────────────────────┘    │
 │  └──────────────────────────┘                                       │
 └──────────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
src/
  core/                 # Types, contracts, message builders, capability definitions
  runtime/              # MessageBus, Mailbox, Supervisor, WorkerPool, WorkerBridge
  objects/              # System objects: Registry, Factory, LLM, Negotiator, Agent, Workspaces
  objects/capabilities/ # HttpClient, Storage, Timer, Clipboard, Console, FileSystem, WebBrowser, WebParser
  objects/widgets/      # Canvas UI toolkit: buttons, text inputs, layouts, windows (~20 widgets)
  protocol/             # Negotiator, Agreement management, HealthMonitor
  llm/                  # Provider interface + implementations (Anthropic, OpenAI, Ollama)
  network/              # Transport abstraction, WebSocket, PeerTransport, SignalingClient, NetworkBridge
  sandbox/              # WASM loader, capability-enforced imports
  ui/                   # App shell, Canvas Compositor, Window Manager
server/                 # Node.js backend: server entry, signaling server, node worker adapter
client/                 # Thin browser client: FrontendClient, input forwarding
workers/                # Web Worker / Worker Thread entry points
tests/                  # Playwright E2E specs
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
| **WebBrowser** | Headless browser automation (Playwright, server-only) |
| **WebParser** | HTML parsing and content extraction (linkedom, server-only) |

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

### Server Mode

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Anthropic Claude API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `WS_PORT` | `7719` | WebSocket port for client connection |
| `SIGNALING_PORT` | `7720` | Signaling server port for P2P discovery |
| `ABJECTS_DATA_DIR` | `.abjects` | Persistent storage directory |
| `ABJECTS_WORKER_COUNT` | CPU cores - 1 (max 8) | Worker thread pool size |

## License

GPL-3.0-or-later - See [LICENSE](LICENSE) for details.
