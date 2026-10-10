# cli/ - The `abject` Command

The command line for Abject: a terminal chat with the agents (a tabbed
full-screen TUI, or a plain line REPL), guided setup, and the commands that
run, stop, inspect, update and register a backend. It is a client of the
backend's terminal gateway (`CliServer`, `server/cli-server.ts`), so it works
the same against the desktop app and the headless edition: it connects to
whatever backend runs on its data directory. The headless edition's copy also
starts that backend itself when none is running.

## Architecture

```
  abject [command] [--data-dir DIR] [--url ws://host:port] [--plain]
     |
  abject.ts         parse args, pick the data directory, route the command
     |
     +-- locate.ts    which edition this is (ABJECT_EDITION), the data
     |                directory, and the live backend for it:
     |                <dataDir>/instance.json -> ws://127.0.0.1:<cliPort> + owner token
     +-- backend.ts   serve / start / stop / logs a headless backend
     +-- connect.ts   login (owner token, cached token, env login, prompt)
     +-- client.ts    AbjectClient: JSON ops and pushed events
     |
     +-- chat-ui.ts   the chat: TUI (tui.ts) or --plain REPL
     |                (markdown.ts, image.ts render messages)
     +-- settings.ts  /settings /get /set ... and `abject settings`
     +-- setup.ts     guided setup        +-- service.ts  start at login
     +-- update.ts    install-script updates  +-- doctor.ts  checks
     |
     v   WebSocket, JSON text frames
  CliServer (server/cli-server.ts) on CLI_PORT (WS_PORT+4, default 7723)
```

### Editions

The same bundle ships three ways. The launcher that starts it sets
`ABJECT_EDITION`; nothing else decides the edition (`cliEdition()` in
`locate.ts`).

| Edition | Set by | Default data directory | With no backend running |
|---------|--------|------------------------|-------------------------|
| `headless` | the packaged binary (`scripts/sea-bootstrap.cjs`) | the OS per-user directory (`server/data-dir.ts`) | starts one in the background (plain `abject`, `start`, `setup`) |
| `desktop` | the app's launcher in `resources/cli` (written by `electron/afterPack.cjs`) | the OS per-user directory | waits for the app (`start` too); `serve` and `restart` refuse, and `stop` refuses a desktop backend |
| `dev` | nothing (`pnpm abject` in a checkout) | `.abjects` in the current directory | plain `abject` waits for `pnpm awaken`; `abject start` runs the headless edition from source (`server/headless.ts` through tsx) |

The data directory is the first of: `--data-dir`, `ABJECTS_DATA_DIR`, the
directory chosen in setup (`config.ts`), the edition's default.

### Finding a backend

`findBackend()` in `locate.ts`:

1. `--url` wins. It carries no owner token, so a backend with a login asks for it.
2. Otherwise the data directory's `instance.json` (`server/instance-file.ts`)
   names the backend, if its pid is alive and `GET /healthz` on its `wsPort`
   answers. The target is `ws://127.0.0.1:<cliPort>` plus the record's owner
   token. A backend writes the file only once boot has finished, so waiting for
   a backend means polling this.
3. A record whose backend is gone means none.
4. No record, but the data directory has been used (it holds `storage.db` or
   `storage.json`): the gateway port (`CLI_PORT`, or `WS_PORT`+4) is tried, for
   desktop apps from before the instance file. A fresh data directory never is,
   since whatever answers on a default port then belongs to another instance.

### Login

`AbjectClient.connect()` runs the gateway's handshake: the server sends
`authNotRequired` (done) or `authRequired`, the client answers
`{ type: 'auth', ownerToken }`, `{ type: 'auth', token }` or
`{ type: 'auth', username, password }`, and the server replies `authResult`.
`connect.ts` offers credentials in this order, moving on after each rejection:
the owner token from `instance.json` (a local backend), the session token
cached for that URL, `ABJECTS_AUTH_USER` plus `ABJECTS_AUTH_PASSWORD`, then up
to three username/password prompts at a terminal. A token minted by a login is
cached per gateway URL (seven-day sessions, `server/auth.ts`).

## Commands

| Command | What it does |
|---------|--------------|
| `abject` (or `chat`) | Open the chat. On the headless edition, a first run with an unused data directory asks where data lives first. When the backend has no model, offers guided setup before the chat. `--plain`, or a stdin/stdout that is not a TTY, gives the line REPL. Quitting leaves a headless backend running. |
| `setup` | Guided setup (`setup.ts`), starting the backend first on the headless edition. Restarts a headless backend after a Chromium download. |
| `start` | Start the background backend, or report the one running. The desktop edition waits for the app instead. |
| `stop` | Ask the backend to shut down (`shutdown` op), then SIGTERM, then SIGKILL. Refuses a desktop backend: quit the app instead. |
| `restart` | `stop`, then `start`. Not for the desktop edition. |
| `status` | Version, edition, pid, ports, uptime, workers, display, data directory, workspace count, whether a model is configured, and the questions waiting. Exits 3 when nothing is running. |
| `logs [-f]` | The last 200 lines of `<dataDir>/logs/abject.log`; `-f` follows it. |
| `serve` | Run the headless backend in the foreground (systemd, launchd, Docker). |
| `questions` (or `dialogs`) | List the questions waiting on the person (permission prompts, confirmations, prompts). |
| `answer N <choice>` | Answer question N: an option number for an options dialog, yes/no for a confirmation, text for a prompt. `n`, `no`, `deny` or `cancel` declines any of them. |
| `mode [ask\|allow\|deny]` | Show or set what happens to a permission request no rule covers (the `permissions.mode` setting). |
| `settings <cmd> ...` | The chat's settings commands from the shell, against the active workspace (see Settings below). |
| `service install\|uninstall\|status` | Start the backend at login (`service.ts`). `install` is for the headless edition only; the desktop app has its own. |
| `update [--check]` | Move an install-script install to the newest release (`update.ts`). |
| `doctor` | Check the install (`doctor.ts`). |
| `version` (`-v`), `help` (`-h`) | Print the version, or the usage text. |

Global flags: `--data-dir DIR`, `--url ws://host:port`, `--plain`, `-f`/`--follow`, `--check`.

## Files

- **abject.ts**: the entry and router. `parseArgs()`, `ensureBackend()`
  (find, start or wait for a backend as the edition allows), and one function
  per command. Its top-level catch restores the terminal (leaves the alternate
  screen) before printing an error.
- **locate.ts**: `cliEdition()`, `cliDataDir()`, `dataDirInUse()`,
  `portOpen()` and `findBackend()`, described above.
- **backend.ts**: running the headless backend. `serve()` sets the environment
  and imports the headless server in this process; `startInBackground()`
  re-runs this program as `serve`, detached; `waitForBackend()`,
  `stopBackend()`, `showLogs()`, `installHome()` and `canServe()`.
- **connect.ts**: plain-terminal prompts (`promptLine`, `confirmLine`,
  `chooseLine`), the credential order, and `connectClient()`.
- **client.ts**: `AbjectClient`, the WebSocket client for the gateway, with
  the handshake, request ids and timeouts (30 s by default), pushed events,
  and typed wrappers for the ops below. Row types (`WorkspaceRow`,
  `ConversationRow`, `DialogInfo`, `GoalStatus`, `InstanceSummary`, ...).
- **chat-ui.ts**: `runTui()` (the tabbed full-screen chat) and `runPlain()`
  (the REPL). Message formatting, the goal panel, the dialog queue, the
  settings browser, toasts and the reconnect loop.
- **tui.ts**: a hand-rolled ANSI screen: key parsing (`parseKeys`), ANSI-aware
  wrapping, the alternate screen with a tab bar, a scrollable message area and
  an editable input line.
- **markdown.ts**: markdown to ANSI for transcripts: bold, italic, inline
  code, links, headings, bullets, code fences, quotes, rules. `stripAnsi()`
  for plain output.
- **image.ts**: data-URI images in messages become a short marker plus
  half-block ANSI art (truecolor, or xterm-256). PNG is decoded with fflate,
  JPEG with jpeg-js; other formats keep the marker only.
- **settings.ts**: reading, showing and changing settings by path, shared by
  the TUI, the REPL and `abject settings`.
- **config.ts**: the command's own config file: cached session tokens by
  gateway URL, and the data directory setup chose.
- **setup.ts**: guided setup, in a local half (before a backend exists) and a
  backend half (through gateway ops).
- **service.ts**: start at login through the OS's own service manager.
- **update.ts**: `cliVersion()`, the install-script layout, `runUpdate()`,
  and `restartBackend()`.
- **doctor.ts**: one line per check, each with what to do about it.

## The gateway ops it uses

Requests are `{ id, op, ...params }`; replies `{ id, ok: true, result }` or
`{ id, ok: false, error }`; pushed events `{ event, workspaceId,
conversationId?, data }`. The server side is documented in
[server/README.md](../server/README.md).

- Workspaces: `listWorkspaces`, `switchWorkspace`, `createWorkspace`.
- Chats: `listChats`, `newChat`, `openChat`, `closeChat`, `renameChat`,
  `deleteChat`, `send`, `history`. Opening or creating a chat subscribes this
  connection to its events; a terminal never opens a window on a desktop.
- Goals: `stopGoal`, `pauseGoal`, `resumeGoal` (by conversation), `goalStatus`.
- Questions: `listDialogs`, `respondDialog`.
- The instance: `instanceInfo`, `isConfigured`, `shutdown`.
- External projects: `listProjects`, `setProjectTrusted`, `setProjectAutonomy`.
- Settings: `getSettingsSchema`, `getSettings`, `setSettings`, `listPresets`,
  `applyPreset`, `savePreset`, `deletePreset`, `listModels`,
  `getWorkspaceSettings`, `setWorkspaceSettings`, `listPackages`,
  `setPackageEnabled`, `listSkills`, `setSkillEnabled`, `getUpdateStatus`,
  `updateAction`.

Pushed events: `message`, `titleChanged`, `conversationCreated`,
`conversationDeleted`, `conversationRenamed`, `conversationOpened`, `dialog`,
`dialogClosed`, `settingsChanged`, `toast`, and `goalProgress` (with the goal
event's name in `data.aspect`).

## The chat

**Tabs.** On start the TUI opens one tab per chat whose window is open on a
desktop, across every workspace (the active one first). If none is, it opens
the active workspace's most recent chat, or a new one. Then it queues any
questions already waiting.

**Keys.** A tmux-style chord: the prefix (default Ctrl+A), then a command key.
`ABJECT_PREFIX` changes it (`ctrl+x`, `C-x`, `^x`; the old `COMMUNE_PREFIX` is
read as a fallback; Ctrl+C cannot be the prefix). The same command keys also
work with Alt.

| After the prefix (or with Alt) | Action |
|-------------------------------|--------|
| `c` | pick a workspace, then a chat, to open in a new tab |
| `1`..`9`, `n` / `p`, Left / Right | switch tab |
| `x` | close the tab (the chat keeps running) |
| `w` | list tabs |
| `d` (prefix only) | quit |
| the prefix again | move to the start of the line |

Up, Down, PageUp and PageDown scroll. Ctrl+C twice quits (once while the link
is down).

**Slash commands (TUI).** `/new [title]`, `/open`, `/tabs`,
`/tab N|next|prev`, `/close`, `/rename <title>`, `/delete`, `/history`,
`/stop`, `/pause`, `/resume`, `/ws` (list), `/ws <n|name>` (set the active
workspace, which is what a desktop shows), `/ws new <name>`, `/questions`,
`/answer N <choice>`, `/mode [ask|allow|deny]`, `/projects`,
`/trust <project> [ask|read|edit|full]` and `/trust <project> off`,
`/settings`, the settings commands below, `/help`, `/quit` (or `/exit`).
Anything else is sent to the tab's chat.

**Questions.** Each open dialog takes over the keys in turn: a confirmation
takes `y`/Enter or `n`, an options dialog a digit, a prompt the input line
and Enter; Esc declines. The first answer anywhere wins (a desktop window or
another terminal); the rest see `dialogClosed`.

**Goals.** While a goal runs, a panel under the transcript shows its title,
its tasks in dependency order with what each waits on (the same
`src/core/task-graph.ts` helpers the desktop uses), and the latest activity.
Goal events mark it stale and a `goalStatus` call refreshes it, at most once a
second. Milestones (started, completed, failed) go into the transcript.

**Toasts** from the workspace's notifications show in the top bar, five
seconds each. **Reconnect**: when the link drops the TUI retries until it is
back, then re-queues the waiting questions.

**Plain REPL** (`--plain`, pipes, dumb terminals): `/chats`, `/open N`,
`/new [title]`, `/ws [n|name]`, `/use N` (point the REPL at another workspace
without changing the active one), `/stop`, `/yes`, `/no`,
`/answer <text|number>` (for the latest question), `/help`, `/quit`, and the
settings commands except `/settings`.

## Settings

A path names a field: `<section>.<field>`, where the field may itself be
dotted (`ai.credentials.anthropic`, `ai.tiers.smart`,
`shell.objectRules.Builder`). Global sections come from SettingsManager's
schema (`getSettingsSchema`); workspace sections are `general`, `access`, and,
when the workspace has them, `web` and `appearance`. Values are text parsed
by the field's type: `on`/`off` for switches, `a,b,c` for lists, `none` to
clear.

| Command | Does |
|---------|------|
| `/get [path]`, `/set <path> <value>` | read or change global settings |
| `/add`, `/remove <path> <item>` | one item of a list |
| `/wget`, `/wset <path> <value>` | the tab's workspace (`/wset appearance.theme <id>`) |
| `/presets`, `/preset apply\|save\|delete <name>`, `/models <provider>` | model presets and catalogs |
| `/packages`, `/package enable\|disable <name>` | packages (takes effect at restart) |
| `/skills`, `/skill enable\|disable <name>` | skills |
| `/update [check\|download\|restart now\|auto on\|off]` | the desktop app's updater (AppUpdater) |
| `/settings` (TUI only) | browse and edit everything: Up/Down select, Enter edits, Esc leaves |

From the shell: `abject settings get ai`, `abject settings set shell.enabled off`,
and so on, with the same commands minus the slash.

## Setup, service and updates

**Guided setup** (`setup.ts`). Every step can be skipped with Enter.

1. *Where data lives* (headless edition, before any backend): kept as found
   when the directory already holds data; another folder is saved in the
   config.
2. *AI models*: the backend's built-in presets named `... recommended`, one
   per provider. A key found in `<PROVIDER>_API_KEY` is offered; the key is
   saved with `setSettings` (section `ai`), checked with `listModels`, and the
   preset applied.
3. *Permissions*: `permissions.mode` (ask, allow, deny) and folders added to
   `filesystem.allowedPaths`.
4. Only when both the backend and this command are the headless edition:
   *a login* (section `auth`; this machine keeps getting in through its owner
   token), *Chromium* for web browsing (Playwright's installer into
   `<dataDir>/browsers`, then the backend restarts), and *start at login*.

**Start at login** (`service.ts`) runs `abject serve` under the OS's service
manager, after stopping a background backend (two cannot share a data
directory):

- Linux: a systemd user unit, `~/.config/systemd/user/abject.service`,
  enabled and started. `loginctl enable-linger <user>` keeps it running while
  logged out.
- macOS: a LaunchAgent, `~/Library/LaunchAgents/world.abject.headless.plist`,
  logging to the backend's log file.
- Windows: a scheduled task `Abject` at logon. It runs `abject start` rather
  than `serve`, so no console window stays open.

The service command is `<root>/current/abject` when this binary runs from an
install-script layout, so it survives updates.

**Updates** (`update.ts`). The install scripts (`site/public/install.sh`,
`install.ps1`) lay an install out as:

```
<root>/versions/<version>/   one directory per release (abject + lib/)
<root>/current               link to the version in use (a junction on Windows)
<root>/bin/abject            -> ../current/abject   (Linux, macOS)
```

`<root>` is `~/.abject` on Linux and macOS, `%LOCALAPPDATA%\abject` on Windows.
`abject update` reads the latest GitHub release, downloads
`abject-<version>-<os>-<arch>.tar.gz` (`.zip` on Windows) and its `.sha256`,
refuses on a checksum mismatch, unpacks into `versions/<version>` with `tar`,
stops a running backend, repoints `current`, keeps the newest two versions
(plus the old and new ones), and starts the backend again with the new
binary. Other installs (Homebrew, Scoop, winget, Docker, a checkout) are told
to update the way they were installed; the desktop edition points at the
app's updater.

**Doctor** checks the version and edition, Node 22.5 or newer, a writable data
directory, a live backend (and through it, a configured model and waiting
questions), a pid that is alive but not answering, ports taken by something
else, and on the headless edition start at login and Chromium; finally `npx`
on the PATH, which MCP servers started with npx need.

## Building and shipping

- **Source**: `pnpm abject [args]` runs `cli/abject.ts` with tsx (edition `dev`).
- **Bundle**: `pnpm distill` (`build-cli.mjs`) writes `dist-cli/abject.mjs`,
  one ESM file with `ws` bundled in, Node built-ins external, a `require`
  shim, and `__ABJECT_VERSION__` from `package.json` (what `cliVersion()`
  reports; a source run says `dev`).
- **Headless edition**: `scripts/package-headless.mjs` copies the bundle to
  `lib/cli/abject.mjs` and builds the `abject` binary, a Node single
  executable whose entry is `scripts/sea-bootstrap.cjs`. The bootstrap sets
  `ABJECT_SEA=1`, `ABJECT_HOME` (the binary's directory) and
  `ABJECT_EDITION=headless`, then loads `lib/launch.cjs`, which imports the ESM
  bundle (a single-executable entry cannot import ESM itself).
- **Desktop app**: electron-builder copies the bundle to
  `resources/cli/abject.mjs` (`extraResources` in `electron-builder.yml`), and
  `electron/afterPack.cjs` writes the launcher beside it (`abject`, or
  `abject.cmd` on Windows) that runs the app's own binary as Node
  (`ELECTRON_RUN_AS_NODE=1`, `ABJECT_EDITION=desktop`). Help, Install the
  abject Command puts it on the PATH (`electron/cli-command.ts`).

## Adding a command

1. Add a `case` to `main()` in `abject.ts`, and a line to `HELP`.
2. Get a backend with `ensureBackend(dataDir, args.url, startIfMissing)` and
   a client with `connectClient(target)`; close the client in a `finally`.
3. Anything that starts or stops a backend checks the edition (`canServe()`,
   `cliEdition()`): the desktop app owns its backend.
4. A new gateway op goes into `CliServer.handleOp()` in
   `server/cli-server.ts` as a fixed op (the socket may have no login, so there
   is no general "call any method"), with a typed wrapper in `client.ts` or a
   plain `client.request()`.

A chat slash command goes into `TuiApp.command()` and `helpLines()` in
`chat-ui.ts`, and into the REPL's line handler if it belongs there too. A
settings command goes into `SETTINGS_COMMANDS`, `runSettingsCommand()` and
`SETTINGS_HELP` in `settings.ts`, which gives it to the TUI, the REPL and
`abject settings` at once.

## Gotchas

- The edition comes only from `ABJECT_EDITION`. Running
  `dist-cli/abject.mjs` with plain `node` is the `dev` edition, whose data
  directory is `.abjects` in the current directory.
- `--url` sends no owner token, and when nothing answers there the command
  fails rather than starting a backend.
- One backend per data directory. A second one refuses to boot
  (`assertNoOtherBackend`); the desktop app offers to stop a running headless
  one first (`claimDataDir` in `electron/main.ts`).
- `abject logs` reads only `<dataDir>/logs/abject.log`, which backends started
  by `abject start` (and the macOS LaunchAgent) write. `abject serve` logs to
  its stdout, which a systemd unit sends to the journal, and the desktop app
  keeps its own log.
- `abject stop` against the desktop app's backend is refused on purpose; the
  app's quit is what releases Electron's child processes.
- A token is cached under the exact gateway URL; `ws://localhost:7723` and
  `ws://127.0.0.1:7723` are two entries.
- `abject update` needs `tar` on the PATH (built into Windows 10 and later).
- The TUI writes to the alternate screen. If the process dies without
  restoring it, `reset` brings the terminal back.

## Related

- [server/README.md](../server/README.md): CliServer and its ops, `instance.json`, the data directory, auth
- [electron/README.md](../electron/README.md): the desktop edition of the command
- [deploy/README.md](../deploy/README.md): running the headless edition as a service, Docker
- [packaging/README.md](../packaging/README.md): package-manager manifests
- [scripts/README.md](../scripts/README.md): `package-headless.mjs`, `sea-bootstrap.cjs`
