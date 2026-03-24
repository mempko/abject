# An {abject} Horror

**[abject.world](https://abject.world)**

## The Things That Think

> A grass computing platform where objects communicate via message passing,
> negotiate protocols through an artificial intelligence, and regenerate
> when broken. The successor to Fire★.
>
> *abject (n.) - AI Object. Also: cosmic dread. Both apply.*

## The Ask Protocol

Abjects explain themselves in their own words. When one Abject needs to use
another, it asks: *"What do you do? How should I talk to you?"* The target
reads its own manifest and source, then answers in natural language.

- **ObjectCreator** asks dependencies how to use them before writing a single line of code.
- **ProxyGenerator** asks both sides what they expect, then writes a living translator between them.
- **Chat** lets users ask Abjects about themselves directly. The Abject answers from its own source.

## What Lurks Inside

- **Self-Healing Proxies**: Error rates above 10% trigger LLM proxy regeneration with traffic still flowing. Unknown messages trigger renegotiation. Hot-swap without disruption. Break them. They always grow back.
- **The Negotiator**: An alien intelligence bridges incompatible minds. It reads both manifests, generates a real proxy Abject. Not a shim. A living translator.
- **Everything is Alive**: The registry is an Abject. The factory is an Abject. Even the thing that makes Abjects is an Abject. There is no privileged layer. Only Abjects passing messages in the dark.
- **Containment Protocols**: Untrusted code runs inside a WASM cage. Capability-gated imports. No ambient authority. Abjects cannot touch anything they haven't been explicitly allowed to reach.
- **True Names**: Every peer has a true name: a SHA-256 hash of its public key. ECDSA/ECDH identity. AES-256-GCM encrypted WebRTC channels. Trust is verified, not assumed.
- **Nothing Truly Dies**: Erlang-style supervision with state snapshots. Kill an Abject; it comes back knowing what it knew.

## Symbiogenesis

Every agent framework draws the same line: the agent thinks, the tool obeys.
Abject erases that line. Here, Abjects create Abjects, Abjects interview their
dependencies, and the LLM is just another service, summoned when an Abject needs
a mind, silent otherwise.

- **ObjectCreator** interviews existing Abjects, learns their protocols through the Ask Protocol, and generates living collaborators. The tool teaches the creator how to use it.
- **The Negotiator** reads two incompatible manifests and conjures a living proxy between them, a real Abject, not a shim.
- **The LLM** is a service Abject, summoned when needed, silent otherwise. Abjects create Abjects that create Abjects. The recursion is unlimited.
- **Canvas UI**: Every Abject can paint its own face. An X11-style compositor gives each one a window with buttons, text inputs, layouts, and custom draw commands. The organism has a body.

## Emergence

A Goal and nothing else. The Goal fractures into sub-goals and tasks. Tasks
surface in the TupleSpace, a shared pool visible to every Abject on every
connected peer. Agents watch. Programs watch. Anything can claim a task.
Progress flows back up through the Goal tree.

- **Goal Decomposition**: A Goal decomposes recursively at runtime, shaped by what workers discover as they work. Agents can spawn purpose-built programs for repetitive tasks: no LLM calls, just code, running alongside the thinkers.
- **Cross-Machine Coordination**: Goals are CRDTs that sync across peers through encrypted WebRTC channels with no central server. Kill a peer and the goal survives on every other peer that subscribed.
- **Failure & Recovery**: Failed tasks release their claim and return to the TupleSpace. The system remembers who failed and routes to a different worker next time. Three strikes and the task dies; too many dead tasks and the GoalObserver kills the entire goal.

## The Spreading

Every Abject lives in a workspace. Workspaces control visibility: who can see,
who can reach, who can speak.

| Tier | Name | Behavior |
|------|------|----------|
| **Local** | The Sealed Vault | No routes exposed. Nothing enters. Nothing leaves. |
| **Private** | The Inner Circle | Shared with those you name. Encrypted WebRTC, ECDH key agreement, AES-256-GCM. |
| **Public** | The Open Wound | Visible to all. Any peer can discover, connect, and begin the Ask Protocol. |

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

> Abject grew from the ashes of **Fire★** (firestr.com), a peer-to-peer
> platform for creating and sharing distributed applications. Fire★ called it
> **Grass Computing**: software you can touch, shape, and share directly.
> No cloud. No landlords. Fire★ proved the vision. But it dreamed in C++ and Lua.
>
> Abject is the next incarnation. The same soul in a new body.
> The grass still grows. Now it thinks.

| Fire★ | Abject |
|-------|---------|
| C++ / Qt / Lua | TypeScript / WASM / Canvas |
| RSA 4096 | ECDSA/ECDH + AES-256-GCM |
| Manual app sharing | LLM-mediated protocol negotiation |
| firelocator | Signaling server |

See [PHILOSOPHY.md](PHILOSOPHY.md) for the principles that carry the fire forward.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | - | Anthropic Claude API key (optional) |
| `OPENAI_API_KEY` | - | OpenAI API key (optional) |
| `WS_PORT` | `7719` | WebSocket port for client connection |
| `SIGNALING_PORT` | `7720` | Signaling server port for P2P discovery |
| `ABJECTS_DATA_DIR` | `.abjects` | Persistent storage directory |
| `ABJECTS_WORKER_COUNT` | CPU cores - 1 (max 8) | Worker thread pool size |

API keys can also be configured through the Global Settings UI at runtime.

### Using with Ollama (Local LLM)

Abject works with [Ollama](https://ollama.com) for fully local, private AI. Pull the recommended models:

```bash
ollama pull qwen3:32b     # Smart tier (complex reasoning, code generation)
ollama pull qwen3:8b      # Balanced tier (general purpose)
ollama pull qwen3:4b      # Fast tier (quick tasks, low latency)
```

Start Ollama, then configure in the Global Settings UI:
1. Click the gear icon in the System toolbar
2. Select **Ollama** as the provider
3. Set the Ollama URL (default: `http://localhost:11434`)
4. Assign models to each tier (Smart, Balanced, Fast)
5. Click Save

The tier system lets Abject pick the right model for each task: heavy reasoning uses the smart tier, routine work uses balanced, and quick lookups use fast.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) for details.
