# src/objects/capabilities/ - Capability Objects

Capability objects are the Abjects that reach outside the object system: the
network, the host's files and processes, persistent storage, timers, the web,
the display client's clipboard, screen, speakers and camera, and other peers.
Every other object gets these effects only by sending one of them a message,
so each object here is the one place where its kind of effect is allowed,
refused, recorded or put to the person.

## Architecture

```
  caller (agent, script abject, system object)
     │  request: exec / readFile / request / connect / set ...
     ▼
  MessageBus
     │
     ▼
  capability object ──requestPermission──▶ PermissionBroker ──askPerson──▶ DialogBroker
     │   (ShellExecutor, HostFileSystem,     rules, project autonomy,     desktop dialog or
     │    StreamClient)                      workspace access, prompt mode  terminal answer
     ▼
  host effect: child process, fs, socket, fetch, Playwright page
     │
     └─ display relays (Clipboard, Screenshot, AudioOutput, Speech, MediaStream)
        message UIServer, which forwards to the connected browser client
```

**Why these objects are the only way out.** Generated JavaScript runs in a
script sandbox and WASM modules see only three host imports (send a message,
log, read the clock), so no abject has a file, a socket or a process of its
own. To reach any of those it sends a message to the capability object that
owns it, and that object applies its own rules (and, for host effects, asks
PermissionBroker). There is nothing to declare in a manifest: what an object
may do is decided where the effect happens.

**Permissions.** PermissionBroker (`src/objects/permission-broker.ts`) holds the
permissions authority on ShellExecutor, HostFileSystem, HttpClient and
StreamClient. See [Permissions](#permissions) below.

**Where they run.** Capability constructors are registered on the main thread
in `server/boot.ts` and in every pool worker by `workers/core-constructors.ts`.
The display capabilities (Screenshot, AudioOutput, Speech) and
BrowserWindowHost are registered only by the desktop edition's
`server/ui-layer.ts` and `workers/ui-constructors.ts`, so the headless edition
(`server/headless.ts`) has none of them. Which objects move to the worker pool
is decided by the `workerEligible` lists in `server/boot.ts` and
`server/ui-layer.ts`. Everything here is worker-eligible except MediaStream
(holds live RTC handles) and BrowserWindowHost (Electron window APIs exist
only on the main process's main thread). RunningProcess objects are created by
ShellExecutor on its own bus.

**Global or per-workspace.** HttpClient, Timer, Crypto, Clipboard, WebParser,
WebBrowser, ShellExecutor, HostFileSystem, WebSearch, WebFetch, StreamClient
and the display capabilities are spawned once at boot. WorkspaceManager spawns
a Storage and a FileSystem for every workspace explicitly, and SharedState,
FileTransfer, MediaStream and Console come from `INFRA_OBJECTS` in
`src/objects/workspace-profiles.ts`. Storage and Console also have a global
instance.

## Files

### Network

- **`http-client.ts`**: `HttpClient` (`HTTP_CLIENT_ID`). `request`, `get`,
  `post`, `postJson`, `getBase64` (bytes as a data URI). Only http/https,
  domain allow and deny lists, a master switch, the private-address guard,
  redirects followed by hand so every hop is checked again (credential headers
  dropped on a cross-origin hop), 30 s default timeout, up to 3 attempts on 429
  and 5xx. Sends an `httpExchange` event to the CassetteRecorder only (never a
  broadcast; LLM's own traffic is not recorded).
- **`stream-client.ts`**: `StreamClient` (`STREAM_CLIENT_ID`). Long-lived
  outbound WebSocket and Server-Sent Events connections: `connect`, `send`,
  `disconnect`, `listConnections`. Incoming data reaches dependents as
  `streamOpened` / `streamMessage` / `streamClosed` / `streamError`. Same
  scheme, domain and private-address rules as HttpClient, at most 32 open
  connections; an unlisted domain is put to the permissions authority.
- **`address-policy.ts`**: `AddressPolicy`, `NetworkPolicyError`. The SSRF
  guard shared by HttpClient and StreamClient: private, loopback, link-local,
  CGNAT and reserved addresses are refused, judged on what the host resolves
  to, unless covered by the owner's Private hosts (Settings → Permissions,
  pushed as `updatePermissions { privateHosts }`). Entries are names
  (`localhost:11434`, `*.corp.example`), addresses (`127.0.0.1:8080`) or ranges
  (`10.0.0.0/8`). `connectLookup` re-checks the address a socket actually
  connects to.

### Host access

- **`shell-executor.ts`**: `ShellExecutor` (`SHELL_EXECUTOR_ID`). `exec` runs a
  command and replies with bounded stdout/stderr (stderr budgeted first) plus a
  permission receipt; `start` returns a RunningProcess Abject instead;
  `stopTaskProcesses`, `setDefaultCwd`, `getPlatformInfo`. Every command goes
  to the permissions authority. Authority-only: `updatePermissions`,
  `updateObjectPermissions`, `updateSkillPermissions`. SkillRegistry-only:
  `setSkillEnv`, `setSkillCommands`.
- **`running-process.ts`**: `RunningProcess`. One approved subprocess as an
  Abject: `status`, `readOutput` (byte offset and length, 64 KiB max), `input`,
  `stop`, `wait`. Answers only its owner and ShellExecutor.
- **`host-filesystem.ts`**: `HostFileSystem` (`HOST_FILESYSTEM_ID`). The real
  filesystem: `readFile` (line offset/limit, byte budget), `writeFile`,
  `conditionalWrite`, `editFile`, `edit`, `deleteFile`, `mkdir`, `ls`,
  `readdir`, `glob`, `grep`, `stat`, `exists`, `snapshotTree`, and `grantPath`
  (asks for standing access up front). `~` expands to the home directory;
  symlinks are resolved before the check. Every path goes to the permissions
  authority as a `directory` request.

### Storage and files

- **`storage.ts`**: `Storage` (`STORAGE_ID`). Key-value store: `get`, `set`,
  `delete`, `has`, `keys`, `getByPrefix`, `getPrevious`, `clear`. This base
  class uses IndexedDB and falls back to an in-memory map. The server always
  constructs `NodeStorage` (`server/node-storage.ts`), a subclass on
  `node:sqlite` (one `kv` table, WAL mode, O(1) per key) at
  `$ABJECTS_DATA_DIR/storage.db` (global) and `$ABJECTS_DATA_DIR/ws-<id>/storage.db`
  (per workspace). It imports a legacy `storage.json` once and keeps it as
  `.bak`, which is what `getPrevious` reads.
- **`filesystem.ts`**: `FileSystem` (`FILESYSTEM_ID`). A per-workspace virtual
  filesystem: `readFile`, `writeFile`, `readFileBytes`, `writeFileBytes`,
  `deleteFile`, `mkdir`, `rmdir`, `remove`, `rename`, `readdir`, `stat`,
  `exists`. The tree lives in `metadata.json` and contents in UUID-named blobs
  under `$ABJECTS_DATA_DIR/ws-<workspaceId>/files`; paths normalize inside the
  virtual root, so `..` never escapes to the host. `abject://<typeId>/<path>`
  references (images, audio, video) resolve through it. A tree an older build
  left at `~/.abject/ws-<workspaceId>/files` moves into the data directory the
  first time the workspace opens it (`../data-dir-layout.ts`).
- **`shared-state.ts`**: `SharedState` (`SHARED_STATE_ID`). Named namespaces of
  last-writer-wins registers: `create`, `get`, `getAll`, `set`, `delete`,
  `subscribe`, `unsubscribe`, `listNamespaces`, `removeNamespace`,
  `getSyncScope`. Syncing follows the workspace access mode set by
  WorkspaceManager (`setAccessMode`): `local` never syncs, `shared` syncs only
  with the same workspace on its members' peers, `public` also with other
  public workspaces.
- **`file-transfer.ts`**: `FileTransfer` (`FILE_TRANSFER_ID`). Peer-to-peer
  file transfer over PeerRegistry's DataChannels in 64 KB chunks: `sendFile`,
  `acceptTransfer`, `rejectTransfer`, `cancelTransfer`, `getTransferStatus`,
  `listTransfers`, `getFileData`. Emits `transferRequested`,
  `transferProgress`, `transferCompleted`, `transferCancelled`.

### Time, logging, crypto

- **`timer.ts`**: `Timer` (`TIMER_ID`). `setTimeout`, `setInterval`,
  `clearTimer`, `getTimerInfo`, `delay`, `clearTimersForObject`. Sends
  `timerFired` (with the caller's `data`) to the object that set the timer;
  only the owner can clear it, and a dead owner's timers are cleared on the
  Registry's `objectUnregistered`.
- **`console.ts`**: `Console` (`CONSOLE_ID`). Per-object log buffers capped at
  1000 entries each: `debug`, `info`, `warn`, `error` (attributed to the
  sender), `logFor` (on another object's behalf), `getLogs`, `getObjectLogs`,
  `clear`, `clearObjectLogs`, `setEnabled`. A buffer is dropped when its
  object unregisters.
- **`crypto.ts`**: `Crypto` (no ID constant; discovered by name).
  `randomBytes`, `randomUUID`, `hash`, `hmac`, `timingSafeEqual`,
  `hashPassword` / `verifyPassword` (scrypt, refuses hostile work factors),
  `encode`, `verifySignature` (JWK or PEM public key, JOSE algorithm names).
  For script abjects, whose sandbox has no `crypto`. Holds no keys.

### Web

- **`web-browser.ts`**: `WebBrowser` (`WEB_BROWSER_ID`). Playwright automation.
  One-shot `getRenderedHtml`, `screenshot`, `extractFromPage`; a stateful page
  API (`openPage`, `navigateTo`, `click`, `fill`, `type`, `select`, `hover`,
  `press`, `check`, `waitForSelector`, `getContent`, `getAriaSnapshot`,
  `refAction`, `evaluate`, pointer input `clickAt` / `hoverAt` / `drag` /
  `scroll` / `typeText`, `closePage`, `closeAllPages`, `listPages`); viewer
  methods for WebBrowserViewer (`viewerScreenshot`, `viewerNavigate`,
  `viewerInput`); named persistent login profiles per workspace
  (`listProfiles`, `deleteProfile`). Pages belong to the object that opened
  them and close when it unregisters. As a plain Node server it launches its
  own Chromium; inside the desktop app it attaches over CDP to Electron's
  Chromium and gets its windows from BrowserWindowHost.
- **`browser-window-host.ts`**: `BrowserWindowHost`
  (`BROWSER_WINDOW_HOST_ID`). Electron-only, main thread only: `getCdpEndpoint`,
  `createWindow`, `closeWindow`, `clearSession`, answered for WebBrowser alone.
  Headless pages are offscreen-rendered windows; automation sessions grant no
  browser permissions.
- **`web-parser.ts`**: `WebParser` (`WEB_PARSER_ID`). HTML parsing with
  linkedom, no browser: `querySelector`, `extractLinks`, `extractImages`,
  `extractText`, `extractMeta`.
- **`web-fetch.ts`**: `WebFetch` (`WEB_FETCH_ID`). `fetch` a URL and return
  readable text; composes HttpClient and WebParser by message.
- **`web-search.ts`**: `WebSearch` (`WEB_SEARCH_ID`). `search`, DuckDuckGo HTML
  results by default (no key); composes HttpClient and WebParser.

### Display relays (desktop edition only, except MediaStream)

These send to UIServer, which forwards to the connected browser client.

- **`clipboard.ts`**: `Clipboard` (`CLIPBOARD_ID`). `read`, `write`, `hasText`,
  `readImage`, `writeImage`, `hasImage`. On the server it keeps the last
  written text and image in memory and forwards writes to the client's OS
  clipboard; it cannot read the OS clipboard (a real paste reaches a focused
  widget as input).
- **`screenshot.ts`**: `Screenshot` (`SCREENSHOT_ID`). `captureWindow`,
  `captureDesktop`, `listWindows`, captured by the client's compositor.
- **`audio-output.ts`**: `AudioOutput` (`AUDIO_OUTPUT_ID`). `play` (URL, data
  URI or `abject://` file), `playTone`, `playGraph` (synthesized Web Audio
  voices), `pause`, `resume`, `stop`, `stopAll`, `listPlaybacks`. Re-emits the
  client's end and error notices as `playbackEnded` / `playbackError`.
- **`speech.ts`**: `Speech` (`SPEECH_ID`). `synthesize`, `speak`, `recognize`,
  `listVoices`. Tries LLM providers first (real audio data), then the client
  browser's speech APIs.
- **`media-stream.ts`**: `MediaStreamCapability` (`MEDIA_STREAM_ID`, spawned as
  `MediaStream`). `getUserMedia`, `getDisplayMedia` (captured on the client),
  `addTrack` / `removeTrack` / `muteTrack` on peer connections, `stopStream`,
  `listTracks`, `record` / `stopRecording`, `captureFrame`. Fails with a clear
  error when no client is connected. Main thread only.

## Permissions

`setPermissionsAuthority` is first-caller-wins on ShellExecutor,
HostFileSystem, HttpClient and StreamClient. PermissionBroker claims all four
in its `onInit`; the bootstrap spawns it after the capability objects it
governs and before SettingsManager for that reason. From then on:

- Only the authority may call `updatePermissions` (and ShellExecutor's
  `updateObjectPermissions` / `updateSkillPermissions`). SettingsManager pushes
  the Settings → Permissions values through PermissionBroker's
  `applyToCapability`, which forwards only those three methods. With no broker
  (a stripped bootstrap) SettingsManager claims the authority itself.
- ShellExecutor (`shell`), HostFileSystem (`directory`) and StreamClient
  (`domain`, for an unlisted domain) send `requestPermission` and wait. The
  broker decides from durable rules, the external project's autonomy and the
  calling workspace's access mode; what is still undecided follows the prompt
  mode, a global setting: `ask` (default) puts it to the person through
  DialogBroker's `askPerson`, `allow` allows it once (dangerous or unreadable
  commands still ask), `deny` refuses. The wait lasts as long as the person
  takes: open dialogs heartbeat, so the long request timeouts here only fire
  when nothing is asking anyone any more.
- HttpClient does not prompt per request. Its master switch, allow and deny
  lists and Private hosts arrive as settings.
- Decisions come back with a `PermissionReceipt` and refusals raise
  `PermissionDenied` (`src/core/permission-outcome.ts`); results of
  ShellExecutor and HostFileSystem carry the receipt.

## Adding a Capability Object

1. Create `<name>.ts` here. Extend `Abject` with a full manifest (interface
   methods with parameters and returns), tags
   `['system', 'capability', '<name>']`, contracts and `checkInvariants()`.
   Export a `<NAME>_ID` constant.
2. Override `askPrompt()` with a usage guide; that is what `ask` answers.
3. Register the constructor in `server/boot.ts` and
   `workers/core-constructors.ts` (display-only objects: `server/ui-layer.ts`
   and `workers/ui-constructors.ts`). A missing worker registration makes the
   spawn fail on the pool.
4. Add the name to `workerEligible` unless it holds main-thread-only handles.
5. Spawn a global one with `supervisedSpawn` in `server/boot.ts` (or in the UI
   layer); a per-workspace one goes in `INFRA_OBJECTS` in
   `src/objects/workspace-profiles.ts`.
6. Export it from `src/index.ts` unless it is server-only (see the note there).
7. If it acts on the host or the network for another object, follow ShellExecutor: accept
   `setPermissionsAuthority` once, take `updatePermissions` only from the
   authority, ask the authority with `requestPermission`, and add the object
   to `claimAuthority` in PermissionBroker (and the fallback list in
   SettingsManager).

## Gotchas

- **Clean up per owner.** Anything held for a caller (timers, pages,
  processes, connections) must go when the caller dies: subscribe to the
  Registry and handle `objectUnregistered`, as Timer, Console and WebBrowser
  do, or handle `recipientGone`, as HttpClient and StreamClient do.
- **DNS rebinding.** HttpClient checks addresses before `fetch`, which takes no
  lookup hook, so a name whose answer changes between the check and the
  connection is not caught there. StreamClient passes `connectLookup` to its
  sockets and is covered.
- **Remote images.** Fetch remote images server-side (`getBase64`) and draw the
  data URI. A cross-origin image drawn on a surface canvas taints it.
- **Display relays need a client.** With no browser connected, MediaStream
  capture fails and Clipboard writes stay in memory. The headless edition has
  no Screenshot, AudioOutput, Speech or BrowserWindowHost at all, and the
  headless bundle check (`scripts/headless-bundle-check.mjs`) fails the build
  if `screenshot.ts` or `browser-window-host.ts` reaches a headless bundle.
- **One data root.** Storage, FileSystem blobs and CollectionStore databases
  all live under `$ABJECTS_DATA_DIR`, so instances with different data
  directories never share them. `~/.abject` is the command line's install
  root, not a data location.
- **Keep `askPrompt()` current.** Agents learn these objects from it and from
  the manifest, not from this file.

## Related

- [../README.md](../README.md): the rest of the system objects
  (PermissionBroker, DialogBroker, SettingsManager, WorkspaceManager)
- [../../runtime/README.md](../../runtime/README.md): MessageBus,
  interceptors, worker pool
- [../../core/README.md](../../core/README.md): manifests, contracts,
  capabilities
- [../../../server/README.md](../../../server/README.md): bootstrap and
  editions
- [../../../workers/README.md](../../../workers/README.md): worker
  constructor maps
