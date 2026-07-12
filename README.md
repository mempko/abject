# Abject: An Abject-Oriented OS

**[abject.world](https://abject.world)**

## The Things That Think

> A self-aware object runtime and grass computing platform: objects
> communicate via message passing, negotiate protocols through an
> artificial intelligence, and regenerate when broken. The successor to Fire★.
>
> *abject (n.) 1. an AI object. 2. 'utterly hopeless'. Anyone who has
> maintained object-oriented code knows the two meanings are compatible.*

## Why

Most people never use a computer to compute. They read, watch, and scroll
inside sealed apps somebody else wrote, because software stayed hard to
make and making it stayed a profession. LLMs just cracked that open. Abject
is where that matters: anyone who can say what they want gets software that
is personal, connected, and theirs, running on their machine, under their
control, with nobody collecting rent.

Underneath is a blunt technical position: AI agents are the wrong
abstraction. Agent frameworks are hierarchies; MCP and A2A are plumbing
between things that shouldn't need plumbing. The abstraction that scales is
the one that already runs the world: objects passing messages (cells, the
internet). What was missing, and what LLMs finally provide, is a way for
objects to understand each other without rigid schemas.

The longform version lives on the blog:

- [An Abject Horror](https://blog.mempko.com/an-abject-horror/): the
  announcement. Why agents are the wrong abstraction, and what a
  self-aware object runtime is.
- [Entering the Architecture Age](https://blog.mempko.com/entering-the-architecture-age/):
  the software pyramid, the Window Tax, and why the big idea is messaging.
- [A Love Letter to Object Orientation](https://blog.mempko.com/a-love-letter-to-object-orientation/):
  why "the internet is an object-oriented system" is not a metaphor. Alan
  Kay's big idea was messaging, not classes.
- [Let the Information Monopolies Crumble!](https://blog.mempko.com/let-the-information-monopolies-crumble/):
  the human case. Computers are for computing, and everyone should get to.

## The Ask Protocol

Abjects explain themselves in their own words. When one Abject needs to use
another, it asks: *"What do you do? How should I talk to you?"* The target
reads its own manifest and source, then answers in natural language.

- **ObjectCreator** asks dependencies how to use them before writing a single line of code.
- **ProxyGenerator** asks both sides what they expect, then writes a living translator between them.
- **Chat** lets users ask Abjects about themselves directly. The Abject answers from its own source.

Ordinary messages never touch an LLM: they are typed payloads on a message
bus, fast and deterministic. The LLM is a service an Abject calls when it
actually needs to think (negotiating with a stranger, generating a new
object, answering a question in plain English).

## The Standard Bestiary

- **Self-Healing Proxies**: Error rates above 10% trigger LLM proxy regeneration with traffic still flowing. Unknown messages trigger renegotiation. Hot-swap without disruption. Break them. They always grow back.
- **The Negotiator**: Bridges incompatible interfaces. It reads both manifests, generates a real proxy Abject. Not a shim. A living translator.
- **Everything is an Abject**: The registry is an Abject. The factory is an Abject. Even the thing that makes Abjects is an Abject. There is no privileged layer. Just Abjects passing messages.
- **Containment Protocols**: Untrusted code runs inside a WASM sandbox. Capability-gated imports. No ambient authority. Abjects cannot touch anything they haven't been explicitly allowed to reach.
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

A Goal, and a planner that keeps re-planning. The **ScrumMaster** runs each
goal as a series of scrums: every round it reviews what the previous round
produced, asks the team what each agent can do (the Ask Protocol; agents
answer with an approach or PASS), stages a batch of tasks each assigned to
the best-fit agent, and records them in a shared **TupleSpace**. When every
task in the round reaches a terminal state, the planner reviews and decides:
complete the goal, plan another scrum, or fail it. Some agents think with an
LLM; some just run code; some were spawned by another agent five minutes ago.

- **Iterative Decomposition**: The plan is not decided up front. Each scrum reads the prior round's results (including failures) and rewrites what comes next. The plan adapts as the system discovers what the work actually needs.
- **Cross-Machine Coordination**: Goals and TupleSpace tuples are CRDTs that sync across peers through encrypted WebRTC channels with no central server. Kill a peer and the goal survives on every other peer that subscribed.
- **Failure as Context**: There is no fixed retry budget. A failed task ends with its error attached to the goal's history; the next scrum reads that history and decides whether to schedule a corrective task, route the work to a different abject, or fail the goal. A separate **GoalObserver** watches from outside and auto-fails goals that go silent for too long.

## The Mesh

Every Abject lives in a workspace. Workspaces control visibility: who can see,
who can reach, who can speak.

| Tier | Name | Behavior |
|------|------|----------|
| **Local** | The Sealed Vault | No routes exposed. Nothing enters. Nothing leaves. |
| **Private** | The Inner Circle | Shared with those you name. Encrypted WebRTC, ECDH key agreement, AES-256-GCM. |
| **Public** | The Commons | Visible to all. Any peer can discover, connect, and begin the Ask Protocol. |

## Summon the System

### Prerequisites

- **Node.js 20+** (recommended). Node 18 works but requires the `--experimental-global-webcrypto` flag. Download from [nodejs.org](https://nodejs.org) or use [nvm](https://github.com/nvm-sh/nvm).
- **pnpm** - install via `npm install -g pnpm` or see [pnpm.io/installation](https://pnpm.io/installation) for other methods (Homebrew, Corepack, standalone script, etc.).

### Setup

```bash
# Clone the repository
git clone https://github.com/mempko/abject
cd abject

# Install dependencies
pnpm conjure

# Start the backend server (Node.js + worker threads)
pnpm awaken                     # ws://localhost:7719

# Start the browser client (new terminal)
pnpm scry                       # http://localhost:5174

# Start a local signaling server (optional, signal.abject.world is used by default)
pnpm whisper                    # :7720
```

| Command | What it does |
|---------|-------------|
| `pnpm conjure` | Install dependencies (`pnpm install`) |
| `pnpm awaken` | Start the Node.js backend where all Abjects live |
| `pnpm scry` | Start the thin browser client (Canvas UI over WebSocket) |
| `pnpm whisper` | Start a local signaling server (optional, `signal.abject.world` is used by default) |

Three processes. One living system.

### Incarnation (Desktop App)

Package Abject as a standalone desktop app for Linux, Windows, or macOS.

```bash
# Build desktop app for your platform
pnpm incarnate:linux    # AppImage, .deb
pnpm incarnate:win      # NSIS installer, portable
pnpm incarnate:mac      # .dmg, .zip

# Build for all platforms
pnpm incarnate:all
```

| Command | What it does |
|---------|-------------|
| `pnpm incarnate:<platform>` | Package as a standalone Electron desktop app |
| `pnpm bind` | Compile the server bundle only |
| `pnpm etch` | Compile the client bundle only |

Requires Electron. Cross-compilation from Linux to Windows works out of the
box. macOS builds from Linux produce unsigned binaries (code signing requires
macOS).

The **backend** is the depths: all Abjects live here, passing messages in a
Node.js process with worker threads. The **browser client** is the surface: a
thin Canvas renderer that forwards input and displays composited frames over
WebSocket. The **signaling server** introduces peers to each other; it never
sees a byte of the conversation.

For running the signaling server in production behind TLS, and pairing it with a
TURN relay so peers behind symmetric NAT or cell networks can still connect, see
[WHISPER.md](WHISPER.md).

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
  sandbox/              # WASM abject hosting: ABI, instance wrapper, module store, extension ingest
  ui/                   # App shell, Canvas Compositor, Window Manager
server/                 # Node.js backend: server entry, signaling server, node worker adapter
client/                 # Thin browser client: FrontendClient, input forwarding
workers/                # Worker thread entry points (shared Abject pool, P2P, UI)
native/                 # Bundled WASM system packages (e.g. the C++ KnowledgeBase)
sdk/cpp/                # C++ SDK for writing abjects that compile to WebAssembly
examples/               # User-loadable WASM abject packages (install with pnpm forge)
docs/                   # Specifications (WASM_ABI.md)
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

## From the Ashes of Fire★

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
| `TURN_SECRET` | - | Shared secret for the signaling server to mint TURN relay credentials (see [WHISPER.md](WHISPER.md)) |
| `TURN_URLS` | - | TURN URLs advertised to peers for NAT traversal (see [WHISPER.md](WHISPER.md)) |

API keys can also be configured through the Global Settings UI at runtime.

The signaling server and its optional TURN relay have their own environment and
deployment guide in [WHISPER.md](WHISPER.md).

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
