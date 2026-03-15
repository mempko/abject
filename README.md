# {abjects} - An Abject Horror

**[abject.world](https://abject.world)**

## The Things That Think

> A grass computing platform where objects communicate via message passing,
> negotiate protocols through an artificial intelligence, and regenerate
> when broken. The successor to Fire★.
>
> *abject (n.) - AI Object. Also: cosmic dread. Both apply.*

## What Lurks Inside

Abjects is an LLM-mediated distributed object system. Everything is alive:
the registry, the factory, the thing that makes objects. They describe
themselves in their own words. They teach each other how to collaborate.

Objects that can't understand each other? The Negotiator reads both minds
and conjures a living translator between them. Not a shim, a real object.
Break it. It grows back. Kill an object, and the Supervisor resurrects it
with memories intact. Nothing truly dies.

## Summon the System

```bash
# Clone the repository
git clone https://github.com/mempko/abjects
cd abjects

# Gather the ritual components
pnpm conjure

# Awaken the depths
pnpm awaken

# Scry into the abyss (new terminal)
pnpm scry            # http://localhost:5174

# Let them find each other in the dark (new terminal)
pnpm whisper         # :7720
```

Three processes. One living system.

The **backend** is the depths: all Abjects live here, passing messages in a
Node.js process with worker threads. The **browser client** is the surface: a
thin Canvas renderer that forwards input and displays composited frames over
WebSocket. The **signaling server** helps peers find each other in the dark.

## What It Does

- **The Ask Protocol**: Every object answers natural language questions about itself. The LLM reads its manifest and source to respond. Objects don't just describe their API; they *teach* each other how to collaborate.
- **Self-Healing Proxies**: Error rates above 10% trigger proxy regeneration with traffic still flowing. Unknown messages trigger renegotiation. Hot-swap without disruption. Break them. They always grow back.
- **The Negotiator**: An alien intelligence bridges incompatible minds. It reads both manifests, generates a real proxy object. Not a shim. A living translator.
- **Everything is Alive**: The registry is an object. The factory is an object. Even the thing that makes objects is an object. There is no privileged layer. Only objects passing messages in the dark.
- **Containment Protocols**: Untrusted code runs inside a WASM cage. Capability-gated imports. No ambient authority. Objects cannot touch anything they haven't been explicitly allowed to reach.
- **True Names**: Every peer has a true name, a SHA-256 hash of its public key. ECDSA/ECDH identity. AES-256-GCM encrypted WebRTC channels. Trust is verified, not assumed.
- **Nothing Truly Dies**: Erlang-style supervision with state snapshots. Kill an object; it comes back knowing what it knew.
- **Workspaces**: Isolated object environments. Local vaults that nothing can reach. Private circles shared only with those you name. Public wounds that bleed into the mesh.
- **Canvas UI**: An X11-style compositor where objects paint their own faces. No other agent framework has a visual body.

## Architecture

```
 ┌─ Node.js Backend (pnpm awaken) ──────────────────────────────────────┐
 │                                                                      │
 │  ┌─────────────────── MessageBus ──────────────────┐                 │
 │  │  Interceptor Pipeline:                          │                 │
 │  │  HealthInterceptor → PeerRouter → Delivery      │                 │
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
 │  ┌──── Server-Only ─────┐  ┌──────── P2P ───────────────────────┐   │
 │  │ BackendUI (headless) │  │ PeerTransport ←→ Signaling Server  │   │
 │  │ WebBrowser (Playwright)  │ IdentityObject (ECDSA/ECDH)       │   │
 │  │ WebParser (linkedom) │  │ PeerRegistry / RemoteRegistry     │   │
 │  └──────────────────────┘  └────────────────────────────────────┘   │
 └─────────────────────────────┬───────────────────────────────────────┘
                               │ WS :7719
 ┌─ Thin Browser Client ──────▼───────────────────────────────────────┐
 │  FrontendClient  │  Compositor (Canvas)  │  Input handling          │
 └─────────────────────────────────────────────────────────────────────┘
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
```

## Design by Contract

Correctness over performance. Every function uses preconditions, postconditions,
and invariants. They are never disabled.

```typescript
function send(message: AbjectMessage): void {
  require(message.header.messageId !== '', 'messageId must not be empty');
  require(message.routing.to !== '', 'recipient must be specified');

  // ... implementation ...

  ensure(this.messageCount > oldMessageCount, 'message count must increase');
}
```

## Capability Objects

| Object | What It Does |
|--------|-------------|
| **HttpClient** | HTTP requests with domain allow/deny |
| **Storage** | Persistent key-value store |
| **Timer** | Scheduling and delays |
| **Clipboard** | System clipboard access |
| **Console** | Debug logging |
| **FileSystem** | Virtual filesystem |
| **WebBrowser** | Headless browser automation (Playwright, server-only) |
| **WebParser** | HTML parsing and content extraction (linkedom, server-only) |

## From Fire to the Abyss

> Abjects grew from the ashes of **Fire★** (firestr.com), a peer-to-peer
> platform for creating and sharing distributed applications. Fire★ called it
> **Grass Computing**: software you can touch, shape, and share directly.
> No cloud. No landlords. Fire★ proved the vision. But it dreamed in C++ and Lua.
>
> Abjects is the next incarnation. The same soul in a new body.
> The grass still grows. Now it thinks.

| Fire★ | Abjects |
|-------|---------|
| C++ / Qt / Lua | TypeScript / WASM / Canvas |
| RSA 4096 | ECDSA/ECDH + AES-256-GCM |
| Manual app sharing | LLM-mediated protocol negotiation |
| firelocator | Signaling server |

See [PHILOSOPHY.md](PHILOSOPHY.md) for the principles that carry the fire forward.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | - | Anthropic Claude API key |
| `OPENAI_API_KEY` | - | OpenAI API key |
| `WS_PORT` | `7719` | WebSocket port for client connection |
| `SIGNALING_PORT` | `7720` | Signaling server port for P2P discovery |
| `ABJECTS_DATA_DIR` | `.abjects` | Persistent storage directory |
| `ABJECTS_WORKER_COUNT` | CPU cores - 1 (max 8) | Worker thread pool size |

For local LLM, run Ollama on localhost:11434.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) for details.
