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
- **Chat** lets people ask about any Abject. The question reaches the Abject, and it answers from its own manifest and source.

Ordinary messages never touch an LLM: they are typed payloads on a message
bus, fast and deterministic. The LLM is a service an Abject calls when it
actually needs to think (negotiating with a stranger, generating a new
object, answering a question in plain English).

## The Standard Bestiary

- **Self-Healing Proxies**: Error rates above 10% trigger LLM proxy regeneration. Change an object's source and its proxies are regenerated against the new interface. The new proxy is swapped in for the old one. Break them. They always grow back.
- **The Negotiator**: Bridges incompatible interfaces. It reads both manifests, generates a real proxy Abject. Not a shim. A living translator.
- **Everything is an Abject**: The registry is an Abject. The factory is an Abject. Even the thing that makes Abjects is an Abject. There is no privileged layer. Just Abjects passing messages.
- **Containment Protocols**: Generated Abjects run in a script sandbox with no file, network, or process access of their own. Code in other languages runs as WASM, which can do nothing but send messages, log, and read the clock. No ambient authority: everything an Abject does is a message to a capability object, and the ones that reach your machine or the network go through a permission broker that follows rules you set or asks you.
- **True Names**: Every peer has a true name: a SHA-256 hash of its public key. ECDSA/ECDH identity. AES-256-GCM encrypted WebRTC channels. Trust is verified, not assumed.
- **Nothing Truly Dies**: Erlang-style supervision with state snapshots. Kill an Abject; it comes back knowing what it knew. Kill the worker thread it lived on; what lived there is rebuilt.

## Symbiogenesis

Every agent framework draws the same line: the agent thinks, the tool obeys.
Abject erases that line. Here, Abjects create Abjects, Abjects interview their
dependencies, and the LLM is just another service, summoned when an Abject needs
a mind, silent otherwise.

- **ObjectCreator** interviews existing Abjects, learns their protocols through the Ask Protocol, and generates living collaborators. The tool teaches the creator how to use it.
- **The Negotiator** reads two incompatible manifests and conjures a living proxy between them, a real Abject, not a shim.
- **The LLM** is a service Abject, summoned when needed, silent otherwise. Abjects create Abjects that create Abjects. The recursion is unlimited.
- **Canvas UI**: Every Abject can paint its own face. An X11-style display server gives each one a window with buttons, text inputs, layouts, and custom draw commands, and the client composites the windows in a WebGL scene. The organism has a body. (The headless edition has none, and works the same without it.)

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
| **Shared** | The Inner Circle | Shared with those you name. Encrypted WebRTC, ECDH key agreement, AES-256-GCM. |
| **Public** | The Commons | Visible to all. Any peer can discover, connect, and begin the Ask Protocol. |

## Summon the System

### Install

The desktop app (AppImage and .deb for Linux, an installer for Windows, .dmg
for macOS) is on the [releases page](https://github.com/mempko/abject/releases).

On a server, or if you live in a terminal, install the headless edition: the
`abject` command with its own backend and no display.

```bash
curl -fsSL https://abject.world/install.sh | sh     # Linux and macOS
irm https://abject.world/install.ps1 | iex          # Windows (PowerShell)
abject                                              # guided setup the first time, then the chat
```

The release archives and a container image (`ghcr.io/mempko/abject`) carry
the same edition; [deploy/README.md](deploy/README.md) covers running it as a
service.

### From Source: Prerequisites

- **Node.js 22.5+** (the server uses `node:sqlite`). Download from [nodejs.org](https://nodejs.org) or use [nvm](https://github.com/nvm-sh/nvm) (`.nvmrc` pins 22).
- **pnpm** - install via `npm install -g pnpm` or see [pnpm.io/installation](https://pnpm.io/installation) for other methods (Homebrew, Corepack, standalone script, etc.).

### From Source: Setup

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

# Chat with the system from your terminal (optional, waits for awaken)
pnpm abject                     # connects to ws://localhost:7723

# Or run with no display at all: the headless edition
pnpm awaken:headless            # then pnpm abject in another terminal
```

| Command | What it does |
|---------|-------------|
| `pnpm conjure` | Install dependencies (`pnpm install`) |
| `pnpm awaken` | Start the Node.js backend where all Abjects live |
| `pnpm scry` | Start the thin browser client (Canvas UI over WebSocket) |
| `pnpm whisper` | Start a local signaling server (optional, `signal.abject.world` is used by default) |
| `pnpm abject` | The `abject` command: chat with your Abjects from a tabbed TUI, answer their questions, change settings |
| `pnpm awaken:headless` | Start the headless edition: the same backend with no display |
| `pnpm incarnate:headless` | Package the headless edition (the `abject` binary and its backend, nothing to install); see [deploy/README.md](deploy/README.md) |

Three processes. One living system.

A few more, for working on it:

| Command | What it does |
|---------|-------------|
| `pnpm abject start` | Start the headless edition from source in the background (`pnpm abject stop` stops it) |
| `pnpm divine` | The browser client in peer-to-peer mode (what `client.abject.world` serves), on :5180 |
| `pnpm forge <dir>` | Build and install an abject package, WASM or script ([docs/PACKAGES.md](docs/PACKAGES.md)) |
| `pnpm smelt` | Rebuild the bundled C++ KnowledgeBase (`native/knowledge-base`) |
| `pnpm typecheck` | Type-check the whole tree |

### abject (The Command Line)

The desktop has a canvas; the terminal gets `abject`. It is a whole way to
run Abject, not only a view: the headless edition is the same backend with
no display, and `abject` starts it in the background, walks you through
setup the first time (where data lives, a model, what agents may do without
asking, an optional login, web browsing, starting at login), and connects.
Quitting the chat leaves the backend running so goals keep going;
`abject stop` stops it and `abject service install` starts it at login.
When the desktop app is running, `abject` talks to it instead (the app ships
its own copy, Help → Install the abject Command), and both share one data
directory, so the workspaces are the same either way.

The chat mirrors the desktop's: one tab per open chat, across every
workspace at once. Chats opened in the GUI appear as tabs live; goals render
as a panel with the task list and per-agent activity; questions from agents
(permission prompts, confirmations) and toasts reach the terminal, and
answering a question in either place resolves it in both. A question waits
until someone answers it: `/questions` in the chat, or `abject questions`
and `abject answer N <choice>` from any shell. For a machine nobody watches,
`abject mode allow|deny` answers requests no rule covers. Markdown renders
as terminal styling.

Keys are tmux-safe chords: `Ctrl+A` then `c` (open chat picker), `n`/`p`
or arrows (switch tab), `1`-`9` (jump), `x` (close tab), `w` (list),
`d` (quit). `Ctrl+A Ctrl+A` jumps to line start; set `ABJECT_PREFIX` to
rebind. Every action also exists as a slash command (`/help` lists them),
and `--plain` gives a line-oriented REPL for pipes and dumb terminals.
`abject help` lists the commands (`status`, `logs`, `setup`, `doctor`,
`update`, `settings get|set`, `serve`, ...).

Settings work from the terminal too. `/settings` opens every setting the
Settings window has (AI keys and tiers, login, permissions, filesystem,
shell, web) plus the current workspace's (name, access, web
exposure, theme): arrow to one, press Enter, type the new value. Keys and
passwords are hidden as you type and never shown again. The same changes
are one-liners for scripts and `--plain`:

```
/get shell                          /set shell.enabled off
/set ai.credentials.anthropic sk-…  /set ai.tiers.smart anthropic claude-sonnet-4-5
/add web.allowedDomains example.com /wset appearance.theme agitprop
/preset apply OpenAI recommended    /skill enable <name>      /update check
```

Changes go through the same Abject that serves the Settings window, so the
window repaints when the terminal changes something and the other way
round.

On the same machine, `abject` gets in with the owner token the backend
writes into its data directory. From elsewhere (`abject --url
ws://host:7723`, through an SSH tunnel), it asks for the login set in
settings and shares the browser client's session tokens. The one-line
installers above put it on your PATH; `abject update` moves an install made
that way to the newest release, and `abject doctor` checks it.

### Incarnation (Desktop App)

Package Abject as a standalone desktop app for Linux, Windows, or macOS.

```bash
# Build desktop app for your platform
pnpm incarnate:linux    # AppImage, .deb
pnpm incarnate:win      # NSIS installer
pnpm incarnate:mac      # .dmg, .zip (Apple silicon and Intel)

# Build for all platforms
pnpm incarnate:all
```

| Command | What it does |
|---------|-------------|
| `pnpm incarnate:<platform>` | Package as a standalone Electron desktop app |
| `pnpm bind` | Compile the server bundles only (desktop and headless; the build fails if display code reaches a headless bundle) |
| `pnpm etch` | Compile the client bundle only |
| `pnpm distill` | Bundle the `abject` command (`dist-cli/abject.mjs`), which the desktop app and the headless edition both ship |

Requires Electron. The app runs the backend inside Electron's main process,
opens the client in a window, uses Electron's own Chromium for web browsing,
and carries the `abject` command. node-datachannel and node-pty are native
modules, so the release workflow builds each platform on its own runner.

The **backend** is the depths: all Abjects live here, passing messages in a
Node.js process with worker threads. The **browser client** is the surface: a
thin renderer that draws what the backend tells it to and sends input back
over WebSocket. The **signaling server** introduces peers to each other; it
never sees a byte of the conversation. The headless edition is the depths
alone, reached through `abject`.

For running the signaling server in production behind TLS, and pairing it with a
TURN relay so peers behind symmetric NAT or cell networks can still connect, see
[WHISPER.md](WHISPER.md).

## Architecture

```
 ┌─ Node.js Backend (desktop: pnpm awaken / the app · headless: abject) ─┐
 │                                                                       │
 │  Main thread                                                          │
 │    MessageBus ── PeerRouter (remote traffic) · proxy routes           │
 │    Registry · Factory · Supervisor · AuthGate · Negotiator            │
 │    CliServer (:7723) · WebGateway (HTTP, off until enabled)           │
 │                                                                       │
 │  Worker pool (worker threads, one bus each)                           │
 │    LLM · capabilities · settings · ProxyGenerator · HealthMonitor     │
 │    workspaces · agents · Chat · KnowledgeBase (C++/WASM)              │
 │    your Abjects (script sandbox, WASM) · windows (desktop only)       │
 │                                                                       │
 │  P2P worker                          UI worker (desktop only)         │
 │    Identity · PeerRegistry             BackendUI: the display server  │
 │    RemoteRegistry · PeerDiscovery                                     │
 └──────┬──────────────────────────┬─────────────────────┬───────────────┘
        │ WS :7719 (desktop)       │ WS :7723            │ WebRTC
 ┌──────▼─────────────────┐ ┌──────▼─────────┐ ┌─────────▼───────────────┐
 │ Thin browser client    │ │ abject         │ │ Peers, paired phones    │
 │ WebGL compositor, input│ │ (terminal)     │ │ (introduced by whisper) │
 └────────────────────────┘ └────────────────┘ └─────────────────────────┘
```

[ARCHITECTURE.md](ARCHITECTURE.md) walks through the layers, the boot
sequence and the main flows.

## Project Structure

```
src/
  core/                 # Types, contracts, messages, the Abject base class
  runtime/              # MessageBus, Mailbox, Supervisor, worker pool and bridges
  objects/              # System objects: Registry, Factory, LLM, agents, goals, chat, workspaces, settings, windows
  objects/capabilities/ # HttpClient, Storage, FileSystem, ShellExecutor, WebBrowser, SharedState, ...
  objects/widgets/      # Canvas UI toolkit: windows, layouts, buttons, text, tables, charts, markdown
  protocol/             # Negotiator, agreements, HealthMonitor
  llm/                  # Provider interface and providers (Anthropic, OpenAI, Ollama, OpenRouter, CLI-driven, ...)
  network/              # Transports, PeerTransport, SignalingClient, PeerRouter, binary wire codec
  sandbox/              # Packages (WASM and script): discovery, packages.json, ingest; the WASM host
  ui/                   # The WebGL compositor and 3D scene the browser client draws with
server/                 # Backend: shared boot (boot.ts), desktop and headless entries, display server, gateways, whisper
workers/                # Worker thread entries (pool, P2P, UI) and their constructor tables
client/                 # Thin browser client: FrontendClient, transports, pairing
cli/                    # The abject command: chat TUI, setup, service, update, doctor
electron/               # The desktop app (Electron main process)
native/                 # Bundled WASM system packages (the C++ KnowledgeBase)
sdk/cpp/                # C++ SDK for writing abjects that compile to WebAssembly
sdk/script/             # TypeScript types for script packages
examples/               # User-loadable abject packages, WASM and script (install with pnpm forge)
docs/                   # Specifications (PACKAGES.md, WASM_ABI.md, LLM_PROVIDERS.md, WEB_GATEWAY.md, ...)
deploy/                 # Running the headless edition as a service (systemd unit, environment file)
packaging/              # Package-manager manifests for the abject command
scripts/                # forge, headless packaging, the single-binary bootstrap
site/                   # abject.world
```

## Design by Contract

Correctness over performance. Abjects state their preconditions,
postconditions and invariants with `require`, `ensure` and `invariant` from
`src/core/contracts.ts`. They are never disabled. From `server/auth-gate.ts`,
the object that holds the login every socket checks:

```typescript
this.on('updateAuth', async (msg: AbjectMessage) => {
  contractRequire(await this.isBuiltInCaller(msg.routing.from, AUTH_WRITERS as readonly string[]),
    'AuthGate takes login changes from SettingsManager only');
  // ...
  contractRequire(!enabled || ((username as string) !== '' && (password as string) !== ''),
    'a login needs a username and a password');
  // ... apply the change ...
  this.checkInvariants();
});

protected override checkInvariants(): void {
  super.checkInvariants();
  invariant(!this.authConfig.enabled || (this.authConfig.username !== '' && this.authConfig.password !== ''),
    'AuthGate: login enabled without credentials');
}
```

## Capability Objects

| Object | What It Does |
|--------|-------------|
| **HttpClient** | HTTP requests with domain allow/deny; private and loopback addresses only when you list them under Private hosts |
| **StreamClient** | Long-lived WebSocket and Server-Sent Events connections |
| **Storage** | Persistent key-value store (SQLite), one per workspace plus one global |
| **FileSystem** | A virtual filesystem per workspace |
| **HostFileSystem** | Real files on your machine, through the permission broker |
| **ShellExecutor** | Shell commands on your machine, through the permission broker |
| **WebSearch** / **WebFetch** | Web search, and a page's readable text |
| **WebBrowser** | Browser automation with Playwright (in the desktop app, Electron's own Chromium) |
| **WebParser** | HTML parsing and content extraction (linkedom) |
| **SharedState** | CRDT state that syncs with peers who share the workspace |
| **FileTransfer** / **MediaStream** | Files and media tracks over peer connections |
| **Timer** / **Clipboard** / **Console** / **Crypto** | Timers, the clipboard, per-object logs, hashing and secure randomness |
| **Screenshot** / **AudioOutput** / **Speech** | Desktop only: captures, sound, text to speech and back |

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
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | - | Model keys read at boot (optional; `TYPESAFE_API_KEY` for the TypeSafe decision model too) |
| `ABJECTS_DATA_DIR` | `.abjects` or the OS location | Where the instance keeps its data. A source checkout uses `.abjects`; the desktop app and an installed headless edition use `~/.config/abject` (Linux), `~/Library/Application Support/abject` (macOS) or `%APPDATA%\abject` (Windows), so both see the same workspaces. One backend per data directory |
| `WS_PORT` | `7719` | The browser UI socket on a desktop; `GET /healthz` and `GET /version` on both editions (loopback) |
| `CLI_PORT` / `CLI_BIND` | `WS_PORT+4` / `127.0.0.1` | The gateway `abject` connects to. Bind it wider only with a login set |
| `HTTP_PORT` / `HTTP_BIND` | `WS_PORT+5` / `127.0.0.1` | The HTTP gateway's port and address, when it is enabled (see [docs/WEB_GATEWAY.md](docs/WEB_GATEWAY.md)) |
| `ABJECTS_AUTH_USER` / `ABJECTS_AUTH_PASSWORD` | - | A login for every socket (both or neither); also set in Settings or `abject setup`. A terminal on the same machine gets in with the owner token in `<data dir>/instance.json` |
| `ABJECTS_WORKER_COUNT` | CPU cores - 1 (max 8) | Worker thread pool size (`0` turns the pool off) |
| `ABJECTS_WORKER_MAX_OLD_SPACE_MB` | sized from memory | Heap ceiling per worker (default: three quarters of memory less 512 MB, shared across workers, 512 MB to 8 GB) |
| `ABJECTS_DEDICATED_WORKERS` | on | `0` keeps the peer layer and the display server on the main thread |
| `ABJECTS_PACKAGE_DIRS` | - | Extra package directories ([docs/PACKAGES.md](docs/PACKAGES.md)) |
| `ABJECTS_ALLOWED_ORIGINS` | - | Web pages allowed to open the UI WebSocket besides the desktop app and the dev client (`http://127.0.0.1:VITE_CLIENT_PORT`, default 5174), comma-separated, e.g. `https://abject.example.com` for a client served through a reverse proxy that forwards `/ws`. Pages of any other origin are refused; the CLI gateway refuses all pages |
| `ABJECTS_SIGNALING_URLS` | - | Use only these signaling servers (comma-separated `ws://`/`wss://`); servers learned from peers and the public default are never used (see [WHISPER.md](WHISPER.md)) |
| `ABJECTS_PEER_ADMISSION` | `open` | `allowlist`: connect only with allowed peers (Network → Servers & Peers → Who Can Connect, or `ABJECTS_ALLOWED_PEERS`) |
| `ABJECTS_ALLOWED_PEERS` | - | Peer IDs always allowed to connect (comma-separated) |
| `ABJECT_PREFIX` | `ctrl+a` | The `abject` chat's chord prefix |

Keys and model tiers are usually set at runtime: Settings → AI on the
desktop, `abject setup` or `/set ai.credentials.<provider>` in a terminal.
[deploy/abject.env.example](deploy/abject.env.example) lists the variables a
service needs.

Beside the environment, the data directory holds `packages.json` (packages and
their settings, [docs/PACKAGES.md](docs/PACKAGES.md)) and `profiles.json`
(workspace profiles, [docs/WORKSPACE_PROFILES.md](docs/WORKSPACE_PROFILES.md)).

The signaling server and its optional TURN relay have their own environment
(`SIGNALING_PORT`, `TURN_SECRET`, `TURN_URLS`, ...) and deployment guide in
[WHISPER.md](WHISPER.md).

### Using with Ollama (Local LLM)

Abject works with [Ollama](https://ollama.com) for fully local, private AI. Pull the recommended models:

```bash
ollama pull qwen3:32b     # Smart tier (complex reasoning, code generation)
ollama pull qwen3:8b      # Balanced tier (general purpose)
ollama pull qwen3:4b      # Fast tier (quick tasks, low latency)
```

Start Ollama, then configure it in Settings:
1. Click the gear in the System section of the dock to open Settings, AI tab
2. Under **1 · Credentials**, pick **Ollama** and set its URL (default: `http://localhost:11434`)
3. Under **3 · Model Tiers**, assign a model to each tier (Smart, Balanced, Fast, and Code)
4. Click **Save Settings**

From a terminal the same is `abject setup`, or one tier at a time:
`/set ai.tiers.smart ollama qwen3:32b`.

The tier system lets Abject pick the right model for each task: heavy reasoning uses the smart tier, routine work uses balanced, quick lookups use fast, and agents draft source code on the code tier.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) for details.
