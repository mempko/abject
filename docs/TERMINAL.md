# TERMINAL.md — A Terminal in Abjects, built on a VT core (libghostty)

**Status:** design proposal. Nothing here is implemented yet; this document
records what the codebase does today, what libghostty actually offers, and the
architecture this project should build. Written 2026-11 against `v0.16.6`
(HEAD `4d34a70`).

**Question it answers:** how do we give the person a real terminal inside
Abjects, without turning the object system into an unguarded shell and without
pretending a terminal emulator is something a UI object should own.

---

## 1. Verdict up front

**Recommended path: build the Terminal abjects now on the VT core this repo
already ships (`@xterm/headless`), behind a `TerminalScreen` seam, and treat
libghostty as a drop-in upgrade of that core rather than as the thing the first
version depends on.**

Three findings drive that:

1. **Shell access today is per-command judged, never session-based.**
   `ShellExecutor` asks `PermissionBroker` about *each command* and spawns a
   one-shot `RunningProcess`. A PTY is the opposite shape: you approve the
   session once and then everything typed inside is outside the broker. That is
   the real security decision in this proposal, not the emulator choice.
2. **libghostty is not one library.** What is embeddable is **libghostty-vt**, a
   C library with a stable C ABI from 1.0, released separately under `vt-X.Y.Z`
   tags, with **officially published WebAssembly artifacts**
   (`ghostty-vt-VERSION.wasm`, signed on `release.files.ghostty.org`). The
   `ghostty.h` "internal embedder API" that macOS Ghostty uses is explicitly
   documented upstream as *not for external embedders*.
3. **A PTY and a headless VT screen are already in `package.json`.**
   `@lydell/node-pty` 1.2.0-beta.15 and `@xterm/headless` ^6.0.0 ship, are
   loaded lazily, bundled as runtime deps for the headless packaging, and
   `asarUnpack`ed for Electron. `src/llm/pty-session.ts` has been driving real
   interactive programs (`claude`) through them for a while.

So the terminal is a wiring-and-consent problem, not a from-scratch emulator
problem — and libghostty-vt is the right *long-term* core because its parser is
better (unicode width, kitty keyboard/protocols, OSC 52, selection, search,
snapshot, scrollback compression) and it is available as a sandboxable wasm
module.

---

## 2. How shell access works today (verified in the tree)

### 2.1 The capability owner: `ShellExecutor`

`src/objects/capabilities/shell-executor.ts` (811 lines), tagged
`['capability', 'shell']`, manifest interface `abjects:shell`. It is the one
object that may start a host process on another object's behalf.

- Requests: `exec` (one-shot, waits) and `start` (returns a live
  `RunningProcess` abject: *"ask it how to read output, send input, wait, or
  stop"*), plus `setPermissionsAuthority`, `setSkillEnv`, and an
  `allowedPaths` configuration.
- A master switch: `this.shellDisabled` is set from SettingsManager's shell
  section (`shell.enabled`), with `allowedCommands` / `deniedCommands` sets.
- Command judgement: `validateCommand(...)` builds a command analysis, computes
  `preapproved` from configured programs/paths, and asks the permissions
  authority:

  `requestPermission({ type: 'shell', resource: <command line>, physicalPaths, callerId, taskId, untrusted, skillName, skillPreapproved, preapproved, description })`

  A denial throws `PermissionDenied` carrying a receipt
  (`src/core/permission-outcome.ts`).
- **Working-directory scoping** is a second, separate ask (`validatePath`, ~line
  668): `resolvePath` → `physicalGrantRoots(allowedPaths)`, `preapproved =
  isInsideAny(roots, cwd)`, then
  `requestPermission({ type: 'directory', operation: 'read', resource: cwd, callerId, taskId, description: 'Shell working directory: ...' })`.
  `isInsideAny` lives in `src/core/path-scope.js`.
- Spawn: `startProcess` builds `{ ...baseEnv, ...skillEnv, ...req.env }`, and
  constructs a `RunningProcess({ command, args, shell, cwd, env, timeout, owner: callerId, supervisor: this.id, taskId })`, tracked in a `running` map
  (`owner`, `taskId`, `permission`, `child`) and stopped wholesale in `onStop()`.
- `untrusted` is a first-class input: standing/skill grants do not cover an
  untrusted project, and the prompt says so in capitals.

### 2.2 The process object: `RunningProcess`

`src/objects/capabilities/running-process.ts` (120 lines), interface
`abjects:running-process`. **This is the precedent a terminal session should
follow**: a child abject per resource, with its own mailbox and identity.

- Methods: `status`, `readOutput({offset, length})` (≤ 64 KiB pages),
  `input({text, close})`, `stop`, `wait`.
- Output is written to a log file, with bounded `stdout`/`stderr` previews,
  truncation tracking, and the process's own id used as the `outputObjectId`
  other objects page through.
- `authorize(msg)` admits only `spec.owner` and `spec.supervisor`. Nothing else
  can type into or kill a process.
- Children are tracked by `src/runtime/child-processes.ts` so a shutdown reaps
  them.

### 2.3 The PTY we already have

`src/llm/pty-session.ts` (1100 lines) — `PtySession` / `PtySessionPool`:

- `@lydell/node-pty` allocates the pty (`ptyModule.spawn(bin, argv, { name: 'xterm-256color', cols, rows, cwd })`, prebuilt N-API binaries per platform, no node-gyp and no per-Electron rebuild).
- `@xterm/headless` maintains the virtual screen from the byte stream; the file
explicitly frames reading that screen as the operation `tmux capture-pane`
performs.
- Real API surface: `start()`, `write(data)`, `resize(cols, rows)`,
  `screenLines()`, `settle()`, `waitFor(pred)`, `ask(prompt)`, `reset()`,
  `stop()`. Plus `scrubAgentEnv` (drops agent credentials from the child env;
  `TERM=xterm-256color`).
- It is shaped for *driving a CLI agent*, not for a person: no scrollback
  served to a viewer, no input round trip from a browser, no per-cell styles.
  But the plumbing (
  pty → parser → screen text) is exactly what a terminal needs.

### 2.4 Packaging reality for native PTYs

- `package.json`: `@lydell/node-pty` + per-platform optional deps
  (`linux-x64`, `darwin-arm64`, `win32-x64`, …), `@xterm/headless`.
- `build-server.mjs:44` externalises `@lydell/node-pty`.
- `scripts/package-headless.mjs:111` lists it in `runtimeDeps`.
- `electron-builder.yml:52` `asarUnpack`s its addon (and macOS `spawn-helper`).

**Anything new and native would have to earn its place in all three packaging
paths. A wasm module does not — it is a file.**

---

## 3. The security model as implemented

### 3.1 Capability ownership

`src/objects/capabilities/README.md`: a capability object is *the one place
where its kind of effect is allowed, refused, recorded or put to the person*.
Everything else gets the effect only by sending it a message. `ShellExecutor`
owns processes; `HostFileSystem` owns files (`allowedPaths` +
`physicalGrantRoots`/`isInsideAny` + `readOnly`); `HttpClient`/`StreamClient` own
sockets; `Clipboard` is a thin renderer-side capability.

### 3.2 Trust is registration, not naming

`src/core/built-in.ts`: a *built-in* object is an instance of a class compiled
into the server — no `source`, no package owner, no `ownerPeerId`. Privileged
handlers admit a caller with `await this.isBuiltInCaller(msg.routing.from,
['AllowedName'])`. **Names and payload fields prove nothing.** A `ScriptableAbject`,
WASM module, package, proxy or remote peer can call the same method names and
must be refused the same way.

### 3.3 Consent: `PermissionBroker`

`src/objects/permission-broker.ts` (2117 lines), interface `abjects:permissions`:

- Decisions: `accept_once`, `accept_always`, `accept_object`, `accept_session`,
  `accept_class`, `accept_program`, `accept_path`, `deny`, `deny_always`,
  `deny_object`. Every one is recorded with an authority and a reason.
- **Request types are a closed union** (line ~1919):
  `'shell' | 'directory' | 'domain' | 'skill_shell' | 'web_action' | 'mcp_tool'`.
  `web_action` and `mcp_tool` are "outward" (acting beyond this machine) and get
  the strictest treatment.
- Two axes, smaller wins (`ceilingFor(accessMode)`, line 277): the workspace's
  access mode caps the project's `AutonomyLevel`. Levels are
  `'ask' | 'read' | 'edit' | 'full'` (`src/objects/external-project-registry.ts`);
  trust is separate, and an untrusted project is forced to `ask`. A **public
  workspace holds every project at `ask`** — *"nothing in it runs a host command
  unseen however trusted the directory is."*
- Standing rules are scoped by caller and optionally by path root; session
  grants are per task; `promptMode` is `ask | allow | deny` and is pushed here by
  `SettingsManager.applyPromptMode()`.
- **A command approved by policy alone does not get the host's credentials**:
  the broker returns `restrictEnv: true` when *"nobody has ever seen this
  command"* (line ~842). Only a rule the person set up deliberately, or a click,
  keeps the full environment.
- The question itself is drawn as a grouped options dialog (Allow once / Always /
  Deny / …) through `DialogBroker.askPerson`; `Abject.confirm()`,
  `prompt()`, `promptOutcome()` are the helpers.

### 3.4 What a UI object is allowed to be

A window object (`src/objects/widgets/window-abject.ts`) owns a UI surface and
routes input to child widgets. A widget (`src/objects/widgets/widget-abject.ts`)
knows only how to draw itself and react to input. **Neither owns a host effect.**
A UI object that wanted to run a command must ask a capability object, exactly
like an agent does — and now it is judged as *that object's* request.

The input plumbing a terminal view needs already exists:
`CanvasWidget` (`src/objects/widgets/canvas-widget.ts`) forwards
`keydown`, `mousedown`, `wheel`, `paste` (`pasteText`, `image`) to its
`inputTargetId` as an `input` event, and paints a validated 2D draw-command
vocabulary (`clear`, `fillRect`, `fillText`, `drawImage`, paths, gradients) onto
its own offscreen layer. A real OS paste arrives as `{ type: 'paste' }` with
`pasteText` — **not** through the `Clipboard` object.

### 3.5 The gap this design must not walk into

`Clipboard` (verified) writes/reads `navigator.clipboard` in the renderer with
**no `PermissionBroker` ask and no per-caller check**. A terminal that honours
OSC 52 blindly would therefore hand any program the person's clipboard through
a path that never asks. Flagged in §6.

---

## 4. libghostty: verified facts vs assumptions

### 4.1 Verified (upstream headers, packaging doc, npm registry, this host)

- Ghostty's repo is `ghostty-org/ghostty`. Its `include/ghostty.h` calls itself
  *"Ghostty's internal embedder API, a.k.a. libghostty-internal"*, says the only
  consumer is the macOS app, that it is *"tailored to the needs of the macOS app
  and not designed for external use"*, and tells external embedders to **use
  `libghostty-vt`** whose headers live in `include/ghostty/`.
- **libghostty-vt is a virtual terminal emulator library**: *"parsing and
  handling terminal escape sequences as well as maintaining terminal state such
  as styles, cursor position, screen, scrollback, and more."* Its C ABI is
  **stable from 1.0**. It releases on its own `vt-X.Y.Z` tag line (`vt-1.0.0`
  exists alongside `v1.4.0` app tags).
- Surface, from `include/ghostty/vt.h` and neighbours: `terminal.h`, `render.h`,
  `grid_ref.h`, `grid_ref_tracked.h`, `formatter.h`, `screen.h`, `osc.h`,
  `sgr.h`, `style.h`, `key.h` (+ `key/`), `mouse.h` (+ `mouse/`), `paste.h`,
  `selection.h`, `search.h`, `snapshot.h`, `modes.h`, `kitty_graphics.h`,
  `size_report.h`, `color.h`, `unicode.h`, `allocator.h`, `build_info.h`,
  `wasm.h`. Documented usage examples include `c-vt-hello` (create, write,
  print the screen), `c-vt-stream`, `c-vt-render` (draw a frame from a render
  state, walk dirty rows/cells), `c-vt-encode-key`, `c-vt-encode-mouse`,
  `c-vt-paste`, `c-vt-selection`, `c-vt-search`, `c-vt-snapshot`,
  `c-vt-compression` (compress scrollback while idle), `c-vt-kitty-graphics`,
  `c-vt-allocator` (run it on your own allocator).
- Core calls: `ghostty_terminal_new(allocator, &terminal, cols, rows)`,
  `ghostty_terminal_vt_write(...)`, `ghostty_terminal_vt_write_until(...)`,
  `ghostty_terminal_resize(terminal, cols, rows, cell_w_px, cell_h_px)`,
  `ghostty_terminal_set/get(...)`, `ghostty_terminal_reset`,
  `ghostty_terminal_free`. Options include a **write-pty callback** (so the
  library hands you the replies to send back to the child), bell, program status
  (OSC 133), write-pty, glyph protocol.
- **WebAssembly is a first-class, published artifact.**
  `PACKAGING-LIBGHOSTTY.md` documents signed downloads at
  `https://release.files.ghostty.org/libghostty-vt/VERSION/`:
  `libghostty-vt-VERSION.tar.gz` (+ `-deps.tar.gz`, both minisign-signed,
  key `RWQlAjJC23149WL2sEpT/l0QKy7hMIFhYdQOFy0Z7z7PbneUgvlsnYcV`),
  plus prebuilt `ghostty-vt-VERSION.wasm` and `ghostty-vt-VERSION-small.wasm`,
  an Apple XCFramework, and Windows install zips. `include/ghostty/vt/wasm.h`
  documents the Emscripten-style export surface (`ghostty_wasm_alloc`,
  `ghostty_wasm_alloc_opaque`, `ghostty_wasm_take_opaque`, memory growth
  handling) and how to drive `ghostty_terminal_vt_write` from a JS `DataView`.
- Building from source needs **Zig, with an exact major.minor** (libghostty-vt
  1.0.0 → Zig 0.17.0; current `build.zig.zon` says
  `minimum_zig_version = "0.17.0"`), from the *source tarball* (a Git checkout
  builds the app instead, unless you pass `-Demit-lib-vt`).
- Third-party JS wrappers exist on npm today: `libghostty-vt@0.6.3`
  (Apache-2.0, `prime-radiant-inc/ts-libghostty`, wraps Ghostty commit
  `e88c6c0`, ~19 MB unpacked, `engines: { bun: '>=1.3.13' }`), `ghostty-web@0.4.0`
  (MIT, `coder/ghostty-web`, ships `ghostty-vt.wasm`, browser-oriented,
  ~2.2 MB), `@slopus/ghostty-wasm@1.3.6` (MIT, "Node- and browser-friendly").
- This host: Node **v24.22.1**, x64 linux. **No** Zig, **no** Ghostty checkout,
  and **no mention of "ghostty" anywhere in this repository** (a grep over all
  of `src/`, `server/`, `client/`, `cli/`, docs and build scripts finds none).
  `xterm` appears only in `src/llm/pty-session.ts`, `cli/tui.ts`, `cli/image.ts`.

### 4.2 Assumptions (not yet proven — each has a spike in §8)

- **A1.** `ghostty-vt-VERSION.wasm` (or a wrapper's wasm) loads and runs inside
  **Node 24** without extra glue, and `ghostty_terminal_vt_write` + a render-state
  walk is fast enough to repaint a 200×50 screen at 60 Hz from JS.
- **A2.** A per-frame **draw-command diff** (dirty rows → `clear`+`fillText` runs)
  stays inside the canvas widget's batch limits for full-screen TUIs (`vim`,
  `less`, `htop`).
- **A3.** `ghostty_key_*` encoding can be driven from the browser's
  `KeyboardEvent` fields that `CanvasWidget` actually forwards (`key`, `code`,
  `modifiers`) without losing sequences people need (Ctrl/Alt/Meta, kitty
  keyboard protocol).
- **A4.** `@lydell/node-pty` on Windows (ConPTY) behaves close enough for resize
  and paste; not tested here.
- **A5.** Cell metrics can be supplied by the client reliably enough that PTY
  `resize(cols, rows)` matches what the renderer draws (see §7.4 — this is the
  sharpest pre-implementation risk).

---

## 5. Proposal

Two abjects, both built-in classes in this repo, plus one seam.

### 5.1 `Terminal` — the capability (owns the PTY)

- **File:** `src/objects/capabilities/terminal.ts`.
- **Manifest:** name `Terminal`, interface id `abjects:terminal`,
  tags `['capability', 'terminal']`, export `TERMINAL_ID`.
- **Owns:** `Map<sessionId, { owner, taskId, permission, session: TerminalSession }>`,
  the `@lydell/node-pty` allocation, and the master switch (`shell.enabled` from
  SettingsManager's `shell` section, pushed like `setPermissionsAuthority`).
- **Methods**
  - `create({ cwd?, command?, args?, env?, cols, rows, cellWidthPx, cellHeightPx, taskId? })`
    → `{ sessionId, cwd, shell }`. `cwd` defaults to the caller's project root
    (ExternalProjectRegistry `resolveProject`) or `process.cwd()`.
  - `list()` → `[{ sessionId, cwd, owner, taskId, cols, rows, startedAt, exitCode? }]`
    (so `ProcessExplorer` can show terminals beside processes).
  - `close({ sessionId })`, `closeAll()`, `getStatus()`.
  - Internal-to-the-session calls are messages to the session abject, not here.
- **Events:** none carrying terminal bytes. Output is *pulled* by the session's
  owner (bounded, offset-addressed) and pushed as a small `screenChanged`
  notification with a sequence number, matching how `RunningProcess` keeps
  retained output behind a message handle rather than flooding a mailbox
  (Mailbox bound: 1000, overflow drops).

### 5.2 `TerminalSession` — one approved shell, its own abject

- **File:** `src/objects/capabilities/terminal-session.ts`, interface
  `abjects:terminal-session`, tags `['capability', 'terminal']`.
- Modelled **exactly on `RunningProcess`**: constructed with
  `{ pty, owner, supervisor: terminalId, cwd, taskId, permission }`; every
  handler calls `authorize(msg)` which admits only `owner` and `supervisor`.
- **State:** the pty handle, the VT screen model (`TerminalScreen`, §7), a
  bounded raw-output ring (default 1 MB), and scrollback owned by the screen
  model.
- **Methods:**
  - `write({ data })` — keystrokes/encoded sequences; also `paste({ text })`
    which wraps in bracketed paste when the program enabled mode 2004
    (`ghostty_terminal_paste` upstream, or the same bytes by hand).
  - `resize({ cols, rows, cellWidthPx, cellHeightPx })` — pty + screen model.
  - `screen({ sinceSeq? })` → `{ seq, cols, rows, cursor, rows: StyledCellRun[] }`
    (incremental: only rows whose content changed since `sinceSeq`).
  - `text({ lines? })` — plain text of the visible screen (the
    `tmux capture-pane` shape `pty-session.ts` already relies on), so an agent can
    *look* at a terminal without being able to type into it.
  - `scroll({ offset })`, `scrollback({ offset, length })`.
  - `title()`, `status()` (exit code, elapsed, bytes in/out, truncated flags).
  - `close()`, `wait()`.
- **Events (fire-and-forget, throttled to ~30–60 Hz, coalesced):**
  `screenChanged { seq, dirtyRows }`, `exit { code }`, `bell`, `titleChanged`,
  `clipboardRequest` (OSC 52 — see §6.4), `askReplyNeeded` (a VT reply must be
  written back to the pty; the session does that itself through the library's
  write-pty callback, never the viewer).

### 5.3 `TerminalView` — the UI (holds no shell)

- **File:** `src/objects/terminal-view.ts`, **UI object** (desktop only).
- **Registration:** `server/ui-layer.ts` `registerConstructors()` +
  `workers/ui-constructors.ts`; listed in `UI_OBJECTS` in
  `src/objects/workspace-profiles.ts`. `Terminal` goes in `INFRA_OBJECTS` +
  `server/boot.ts` + `workers/core-constructors.ts` (per the repo's rule that a
  missing worker registration is a silent spawn failure).
- **Window:** asks `WidgetManager.createWindowAbject` (the pattern in
  `process-explorer.ts:433`, `file-viewer.ts:121`), answers `show`/`hide`/
  `setTitle`. Inside: one `CanvasWidget` created with
  **`inputTargetId: this.id` passed explicitly** (the widget's own docs insist on
  this) inside a `createVBox` layout.
- **Renders:** on `screenChanged`, pulls `screen({ sinceSeq })` and paints dirty
  rows as a batch of `clear`-less incremental commands: background runs as
  `fillRect`, text runs per style as `fillText` with `fillStyle` set from the
  theme, cursor as a `fillRect`, selection as `fillRect` at low alpha. Monospace
  cell metrics come from `canvasResize`'s `width`/`height` plus the configured
  font size — the *view* owns metrics and tells the session.
- **Input:** `keydown` → encode (libghostty `ghostty_key_*` when available, else a
  small table) → `session.write`. `paste` → `session.paste`. `wheel` →
  `session.scroll`. `mousedown`/`mousemove` → selection (and SGR mouse encoding
  when the program asked for mouse reporting). `canvasResize` → recompute
  cols/rows → `session.resize`.
- **Copy/paste:** copy goes through the `Clipboard` capability (a write, which
  needs no prompt); paste arrives from the compositor as a `paste` event with
  `pasteText` (no clipboard read needed).
- **What it cannot do:** it has no path to `ShellExecutor`, no `child_process`,
  no filesystem. Its only powers are drawing and messaging the session it owns.

### 5.4 The seam: `TerminalScreen`

`src/terminal/screen.ts` — an interface, not an implementation detail:

```
createScreen({ cols, rows, scrollback }): TerminalScreen
TerminalScreen: write(bytes) | resize(cols, rows, cellW, cellH)
                | snapshot(sinceSeq?) -> { cols, rows, cursor, dirty rows of styled cells }
                | text() | scrollback(offset, length) | title() | modes()
                | selection/search (phase 2) | dispose()
```

Two implementations: `xterm-screen.ts` (wraps `@xterm/headless`, today) and
`ghostty-screen.ts` (wraps libghostty-vt wasm, after the §8 spike). Selection
between them by a SettingsManager field, with automatic fallback to xterm if the
wasm fails to instantiate. **This is why the terminal can ship before the
libghostty question is settled.**

---

## 6. How this fits the security model

### 6.1 Who holds what

| Power | Holder | Not held by |
|---|---|---|
| Allocate a PTY, spawn a program | `Terminal` (built-in capability) | `TerminalView`, agents, packages, WASM, peers |
| Type into a session, resize, close | `TerminalSession`, admitted only to its `owner`/`supervisor` | any other object |
| Draw, read keyboard | `TerminalView` (UI, no host effect) | `Terminal` |
| Decide whether a session may exist | `PermissionBroker` (asks the person) | any caller |
| Read the screen | `TerminalSession.text()` for **owner/supervisor only**; an explicit read-only `peek` is a separate, later decision | — |

### 6.2 What the person approves

**One prompt per session — and the prompt must say the truth: after this, you
are in a shell.** Concretely, `Terminal.create` reuses the *existing* permission
types rather than inventing new ones (the union is closed:
`shell | directory | domain | skill_shell | web_action | mcp_tool`):

1. `requestPermission({ type: 'directory', operation: 'read', resource: cwd, callerId, taskId, description: 'Terminal working directory: ...' })`
   — identical to `ShellExecutor.validatePath`.
2. `requestPermission({ type: 'shell', resource: <program>, callerId, preapproved: false, description: 'An interactive shell in <project> — everything typed inside it runs without further prompts' })`.

The broker's existing options dialog supplies Allow once / Allow always /
Allow for this task / Deny, and `deny_always` sticks. Three properties fall out
of reusing the machinery unchanged:

- **Public or shared workspace ⇒ ceiling `ask`**, so a terminal always prompts and
  can never be inherited from a rule set elsewhere (`ceilingFor`).
- **Untrusted project ⇒ `ask`**, and standing/skill grants do not cover it
  (`untrusted` already suppresses them in `ShellExecutor`).
- **Policy-only approval scrubs the environment** (`restrictEnv: true` when
  nobody saw the command). A standing terminal grant should do the same:
  no `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`ABJECTS_*` secrets in the child, reusing
  `scrubAgentEnv` from `pty-session.ts`.

### 6.3 Can the UI execute anything on its own? No — and that is enforced, not promised

- `Terminal.create` accepts only **built-in** callers, checked with
  `isBuiltInCaller(msg.routing.from, ['TerminalView', 'CliServer'])`. A
  `ScriptableAbject`, WASM module, package, or remote peer naming itself
  "TerminalView" is refused by registration, not by name (`src/core/built-in.ts`).
- **Agents are deliberately not on that list.** `AgentAbject`, `ExternalCreator`,
  `WebAgent`, `SkillAgent`, `ObjectAgent` already have `ShellExecutor`, where
  every command is judged. Handing them a PTY would let one approved "open a
  shell" launder unlimited unreviewed commands — the exact bypass the per-command
  model exists to prevent. If an agent ever needs an interactive TUI, that is a
  separate, narrower feature (a supervisor/pty with an allowlisted program and no
  free-form input), not this one.
- **The view never touches `Session.write` on a session it does not own**, and
  `TerminalSession.authorize` is the same owner/supervisor check as
  `RunningProcess`.

### 6.4 Risk surface and mitigations

| Risk | Why it is real here | Mitigation |
|---|---|---|
| Arbitrary command execution | A shell is, by design, exactly that | The *session* is the approved unit; consent text says so; public/untrusted workspaces force a prompt; `shell.enabled` is a hard master switch; sessions are capped and idle-killed |
| Escape-sequence attacks on the host | Parser bugs are memory-safety bugs in C | Parser runs as **wasm** (memory-isolated, no syscalls); one wasm instance per session so a corrupt screen cannot reach another; upstream's own allocator example lets us bound and count its memory. xterm fallback is pure JS |
| Renderer hijack (terminal injecting canvas ops / URLs / JS) | Draw commands are interpreted by the compositor | The screen model yields **typed cell runs**; the view builds the draw batch itself. `CanvasWidget` already rejects a whole batch on an unknown command, so nothing arbitrary gets through |
| Clipboard exfiltration (OSC 52) | `Clipboard` today has **no** PermissionBroker ask | Terminal never writes to `Clipboard` on its own: `clipboardRequest` event → view → an explicit consent ask (or refusal). Separately: add a per-caller ask to `Clipboard` (flagged as a prerequisite, not optional) |
| Unsafe paste | Pasting `rm -rf` shaped text into a shell | Bracket paste when mode 2004 is on; mark multi-line/unsafe pastes in the view; never auto-execute |
| Kitty graphics / images | Arbitrary bytes decoded and drawn | **Off by default.** Enable only if the wasm's decoder is used with hard size caps, and only after the renderer path is reviewed |
| Title / OSC 0-2 / OSC 7 (cwd) | A program choosing window titles and claiming cwd changes | Title is display-only, sanitised, never a path; the session's `cwd` is fixed at spawn and **never** changes because a program asked |
| Output flood / memory | TUIs emit a lot | Bounded ring buffer, bounded scrollback, coalesced `screenChanged`, truncation reporting like `RunningProcess` |
| Peer exposure | A joined workspace could become a remote shell | `Terminal` is spawned per local workspace and `create` requires the local access mode; a remote caller is not built-in, so it is refused twice over |
| Orphaned processes | Closing a window must not leave a shell running | `onStop()` stops every session; children tracked by `runtime/child-processes.ts`; session dies with its owner (the `RunningProcess` rule) |

### 6.5 Project scoping and path boundaries carry over because they are the same calls

`Terminal` does not re-implement path policy. It resolves `cwd` the same way
(`physicalPath`, `resolvePath`, `isInsideAny(allowedPaths)`), defaults to the
active external project's root from `ExternalProjectRegistry`, and asks the
broker the same `directory` question. Anything outside a granted root is a
`PermissionDenied` with a receipt. `ALWAYS_PROTECTED` (`.git/`, `.env`,
`node_modules/`, `.ssh/`) still governs *writes by agents*; a terminal is a
person's shell and is not modelled as an agent write — that asymmetry should be
stated in the prompt rather than quietly exploited.

---

## 7. Build, interop, platforms

### 7.1 What we would ship, per option

| Option | Core | Build/deploy cost | Verdict |
|---|---|---|---|
| **A. libghostty-vt wasm, server-side** | `ghostty-vt-VERSION.wasm` loaded in the Node process; screen/scrollback/search/selection server-side; renderer gets styled cells | One signed `.wasm` file added to `extraResources`/headless `lib/`; no toolchain; no native ABI | **Preferred end state** |
| B. libghostty-vt wasm, client-side | wasm in the browser; raw pty bytes streamed to the view; view parses and draws | Same file served to `dist-client`; but every viewer parses, headless can never read a screen, and the wire carries raw terminal bytes | Viable later, worse first step |
| C. `@xterm/headless` | pure JS, already installed and already used by `pty-session.ts` | Zero new dependency | **Ship this first, behind the seam** |
| D. Native libghostty-vt (Zig → `.so`/`.dylib`/`.dll` + N-API) | real native binding | Zig 0.17.x pinned, 6 platform builds, rebuilds per Electron ABI, new `asarUnpack`, new headless packaging entry, plus code-signing on macOS/Windows | **Not recommended.** No functional gain over upstream's published wasm, and it taxes every packaging path forever |
| E. Vendor third-party npm wrapper (`libghostty-vt`, `ghostty-web`, `@slopus/ghostty-wasm`) | someone else's wasm + TS bindings | A dependency, ~19 MB unpacked for the largest; `engines: bun` on the most complete one | Use **only as a spike shortcut**, not as the shipped dependency, unless A fails |

### 7.2 Why wasm and not native

The repo's own precedent is that native modules cost real money:
`@lydell/node-pty` needed prebuilt N-API packages per platform, an `externals`
entry in `build-server.mjs`, a `runtimeDeps` entry in
`scripts/package-headless.mjs`, and an `asarUnpack` rule in
`electron-builder.yml`. Adding a Zig-built library would add a *toolchain*
requirement to every contributor and CI job, with an exact-minor Zig pin that
changes with every libghostty-vt release. Upstream already signs and publishes
the wasm twin of the same library — a file that needs no compiler, works on every
platform identically, and cannot crash the process it runs in.

### 7.3 Licensing and provenance

libghostty-vt is **Apache-2.0** (the wrappers: `libghostty-vt` Apache-2.0,
`ghostty-web` MIT, `@slopus/ghostty-wasm` MIT). Vendor the signed tarball
artifact, record the version and the minisign check in `scripts/`, and pin the
`vt-X.Y.Z` version in one constant. Do not track `main`.

### 7.4 The sharp practical constraint: cell metrics

A PTY must be told `cols`/`rows`, and the renderer must agree with that number
or every full-screen TUI mis-wraps. The server has **no font metrics** —
`src/ui/compositor.ts` paints with `OffscreenCanvas` in the *client's* process
(the UI worker/browser), and `Screenshot`/`captureWindow` only observes the
result. So:

- the **view** measures one cell (font size, monospace advance, line height,
  device pixel ratio) and sends `cols/rows/cellWidthPx/cellHeightPx`;
- the **session** treats that as authoritative and resizes pty + screen model;
- a resize is debounced (~100 ms) and applied as one `SIGWINCH`-shaped event;
- headless sessions (no view) use a fixed 80×24 until someone attaches.

This is why `cellWidthPx`/`cellHeightPx` are in the `create`/`resize` payloads
and why A5 is listed as a risk rather than a detail.

---

## 8. Implementation sequence (each step independently shippable)

**Step 0 — Spike, 1 day, throws nothing away.** Load
`ghostty-vt-1.0.0.wasm` (signed, from `release.files.ghostty.org`) under Node
24; `ghostty_terminal_new` + `vt_write` of a colour sequence; walk the render
state for dirty rows; measure bytes/s and a 200×50 repaint. Repeat with
`@xterm/headless` as the baseline. **Kills or confirms A1/A2 before any abject is
written.** Also: does `ghostty-web`'s wasm instantiate under Node (A1 fallback)?

**Step 1 — `TerminalScreen` seam + xterm implementation.** Port the proven
parts of `pty-session.ts` (screen text, `resize`, soft-wrap rejoining) into
`src/terminal/`. Unit tests: write/resize/alt-screen/scrollback/`text()`.

**Step 2 — `TerminalSession`.** pty via `@ldell/node-pty` (note: `@lydell`),
owner/supervisor `authorize`, bounded ring, `screen({sinceSeq})`,
`write`/`paste`/`resize`/`scroll`/`close`/`wait`. Tests drive a real `bash -lc`
and a full-screen program.

**Step 3 — `Terminal` capability.** `create`/`list`/`close`, the two permission
requests, the built-in caller allowlist, session caps and idle kill, the
`shell.enabled` gate, `restrictEnv`/`scrubAgentEnv`. Tests:
`agent-system.permissions.test.ts` style — spoofed callers refused, public
workspace forced to ask, untrusted project forced to ask.

**Step 4 — `TerminalView`.** window + canvas + `inputTargetId: this.id`, dirty-row
painting, key encoding, paste, resize, scroll, selection/copy through
`Clipboard`. Verify by driving the real compositor path (not a synthetic
`input` call — the widget docs are explicit that a synthetic call proves
nothing about the chain).

**Step 5 — Registration and docs.** `workers/core-constructors.ts`,
`server/boot.ts`, `workers/ui-constructors.ts`, `server/ui-layer.ts`,
`INFRA_OBJECTS`/`UI_OBJECTS` in `\`src/objects/workspace-profiles.ts\``,
`src/index.ts` exports, this document, `docs/README.md`, and the
`src/objects/capabilities/README.md` entry. `pnpm typecheck && pnpm test`.

**Step 6 — libghostty upgrade.** `ghostty-screen.ts` behind the seam, the wasm
asset in desktop `extraResources` and headless `lib/`, a settings toggle with
automatic fallback, and the OSC 52 / kitty-graphics switches off by default.

**Step 7 — Prerequisite hardening (can move earlier).** Give `Clipboard` a
per-caller ask through `PermissionBroker`. Without it, OSC 52 has no safe path.

---

## 9. Alternatives considered

- **Reuse `ShellExecutor.start` with `shell: true` and pretend it is a
  terminal.** Rejected: its contract is one command, judged once, output paged by
  offset. It has no resize, no live input round trip a UI can drive, no screen
  model — and, worse, extending it would blur the line that makes the capability
  auditable.
- **Expose the existing `abject` TUI (CliServer) inside a window.** That shows a
  *client of the Abjects API* in a box; it does not give a shell, and it inverts
  who is in charge.
- **A browser-only emulator wired straight to a websocket.** Would bypass the
  object system entirely: no capability owner, no consent, no receipts, no
  ProcessExplorer visibility. This is the design this proposal exists to avoid.
- **WebBrowser on a web terminal (ttyd/gotty).** Same objection, plus it needs a
  second server and a port.

---

## 10. Open questions for the author

1. **Consent granularity.** Is "Allow always for TerminalView in this project"
   acceptable, or should every session prompt even inside a trusted project at
   `full` autonomy? (Recommendation: the standing rule is per project root and
   per caller, and `restrictEnv` always applies to it.)
2. **Should an agent ever read a terminal?** `text()` for owner/supervisor only
   keeps agents out entirely. A read-only `peek` (no write path) may be worth it
   for "look at what the build is doing" — but it also leaks whatever is on that
   screen. Decide deliberately.
3. **Multiple viewers per session.** One owner is the safe default. A tmux-like
   "attach second viewer" needs a shared-session grant that outlives an owner —
   out of scope for v1.
4. **Persistence.** Should a session survive a backend restart (snapshot via
   libghostty's `snapshot.h`, pty re-spawned)? v1 says no: sessions are
   process-scoped, like `RunningProcess`.
5. **Windows/macOS first-class or "it opens"?** ConPTY + GNU-less shells will
   need a pass; the proposal keeps shell choice configurable for that reason.

---

## 11. What was verified vs assumed, in one line each

**Verified:** `ShellExecutor`/`RunningProcess` shapes and their consent calls;
`pty-session.ts` and the pty/xterm dependencies (already packaged for desktop +
headless); PermissionBroker's decision vocabulary, closed request-type union,
`ceilingFor`, `restrictEnv`; autonomy/trust rules and `ALWAYS_PROTECTED`;
built-in trust by registration; `CanvasWidget` input forwarding and draw-command
validation; `WidgetManager` factory names; `Clipboard` having no broker ask;
libghostty-vt exists as a separate Apache-2.0 C library with a stable 1.0 C ABI,
published wasm artifacts, a Zig build path, and two/three third-party npm
wrappers; nothing in this repo mentions Ghostty; the host has no Zig.

**Assumed:** wasm-under-Node-24 practicality and speed (A1); draw-command
diffing staying within batch limits (A2); browser `KeyboardEvent` sufficiency for
key encoding (A3); Windows ConPTY parity (A4); client-supplied cell metrics (A5).
