# src/core/ - Core Foundation

The object model every other module builds on: the `Abject` base class, the
message envelope and its builders, Design by Contract, manifests,
introspection, and peer identity. Around that sit small shared
libraries that several objects (and sometimes the browser client or the CLI)
need to agree on: shell-command analysis, path containment, exact-text file
edits, decision-site policy, the KnowledgeBase vocabulary, skill parsing,
and theme data.

Core is workspace-agnostic: nothing here knows about workspaces, windows or a
display. Workspaces, the UI and agents are built on top of it in
`src/objects/`.

## Architecture

```
            ┌──────────────────────── Abject (abject.ts) ────────────────────────┐
 manifest ─►│ id (UUID) + typeId    handlers: Map<method, fn>                    │
            │ init(bus) ─► bus.register(id) ─► Mailbox ─► processMessages()      │
            │   loop: reply/error ─► resolve the pending request()               │
            │         anything else ─► handleMessage() ─► handler (not awaited)  │
            │                          return value ─► automatic reply           │
            │ send(msg)    request<T>(msg, timeoutMs)    sendDeferredReply()     │
            └───────────────┬────────────────────────────────────────────────────┘
                            │ AbjectMessage built by message.ts
                            ▼
                  MessageBusLike (src/runtime): MessageBus on the main
                  thread, WorkerBus inside a worker thread
```

An Abject never calls another Abject's methods. It builds a message with
`request()` / `event()` from `message.ts` and hands it to the bus with
`this.request()` (wait for the reply) or `this.send()` (fire and forget). The
receiver's processing loop pulls the message from its mailbox and calls the
handler registered for `routing.method`. Whatever the handler returns (or
resolves to) becomes the reply.

Dependencies point down. `abject.ts` needs `Mailbox` and the
`MessageBusLike` type from `src/runtime/`, and it and `decision-questions.ts`
take decision types from `src/llm/decision.ts`. Everything else in core
depends only on other core files, Node built-ins, `uuid` and `yaml`.

## The Abject base class

`abject.ts` holds `Abject` (abstract) and `SimpleAbject` (name, description
and a handler dictionary, no subclass needed).

**Identity.** `id` is an ephemeral UUID (or one passed as `options.id`).
`typeId` is the durable, scoped identity set before init with `setTypeId()`:
`{peerId}/system/{Name}` for system objects, `{peerId}/{workspaceId}/{Name}`
for workspace built-ins, `{peerId}/{workspaceId}/user/{Name}` for user
objects.

**Trust.** Privileged handlers admit callers with `isBuiltInCaller(id,
names?)`: the caller's registration says it is an instance of a class
compiled into the server (no `source`, no package owner, not a remote peer's;
`built-in.ts`), registered under one of `names`. A name alone, or a name from
a payload, proves nothing. Built-in cannot be claimed: the Factory builds a
server class only for a built-in requester, and the registries take writes
to another object's entry only from built-in senders.

**Manifest.** `AbjectManifest` has a single `interface: InterfaceDeclaration`
(not an array). The constructor merges `INTROSPECT_METHODS` and
`INTROSPECT_EVENTS` into it unless it already declares `describe`.

**Lifecycle.** `init(bus, parentId?, registryHint?)` registers the mailbox,
installs the built-in handlers, starts the processing loop, awaits `onInit()`,
runs `checkInvariants()`, and sends `childReady` to the parent. `stop()` sets
the status to `stopped`, awaits `onStop()`, cancels managed timers, rejects
pending requests and unregisters from the bus. Inside `onStop()` `send()`
still works; `request()` rejects at once. States: `initializing`, `ready`,
`busy`, `error`, `stopped`. `error` is a sticky health flag, not a gate: an
object in `error` keeps sending, and the next successful handler clears it.

**Built-in handlers** (installed by `init()`): `describe`, `ask`, `ping`,
`addDependent`, `removeDependent`, `getRegistry`, `getResultContract`, and
`progress`. A subclass's own `ping` handler is kept, and its own `progress`
handler runs after the built-in one; the others are overwritten, so customize
`ask` through the hooks below.

**Messaging.**
- `on(method, handler)` / `off(method)`; `'*'` is the catch-all. A request
  with no handler gets a `METHOD_NOT_FOUND` error reply.
- `send(msg)` is fire and forget. `request<T>(msg, timeoutMs = 30000)` takes
  a pre-built request message and resolves with the reply payload or rejects
  with an `Error` whose message is `CODE: message` (with `.code`, `.details`).
- The request timeout is a stall timer: every `progress` event from the target
  resets it. The default `progress` handler also bubbles the event to whoever
  is waiting on this object, so long work anywhere down a call chain keeps
  every caller alive. Events carrying a `taskId` reach only callers serving
  that task.
- Return `DEFERRED_REPLY` from a handler to answer later with
  `sendDeferredReply(original, result)`; `forgetDeferredRequest()` drops the
  bookkeeping when someone else will answer.
- `changed(aspect, value)` notifies dependents twice: a generic `changed`
  event `{ aspect, value }` and an event named after the aspect. Subscribe to
  one shape, not both.
- `onDelivery(method, handler)` makes a method idempotent per
  `(sender, payload.deliveryId)`: retries join the same work.
- `rejectPendingRequestsTo()`, `rejectPendingRequest()`, `resetRequestTimeout()`
  manage outstanding requests by hand.

**Discovery.** `discoverDep(name)` asks the Registry once and returns `null`
when absent; `requireDep(name, { timeoutMs })` retries with backoff (default
10s) and throws, for hard dependencies whose registration may lag;
`resolveDep(name, cached)` discovers only when the cached id is missing. The
Registry id comes from `setRegistryHint()` / the `registryHint` init argument,
or from asking the parent chain (`getRegistry`).

**Ask protocol.** `ask` answers a natural-language question about the object
by calling the `LLM` object: `askPrompt()` builds the system prompt (default:
the manifest as prose), `askTier()` picks the model tier (default `'fast'`),
`handleAsk()` can be overridden wholesale, and `askLlm()` is reusable for
custom prompts. The requester's question is wrapped in nonce-marked fences
so it cannot rewrite the instructions. `askBusyStatus()` returning a string
answers at once from the manifest instead of queuing behind LLM work
(`askAvailabilityContext()` adds non-LLM facts). Without an LLM the reply is
`[No LLM available]` plus the manifest description; `isTemporaryAskResponse()`
recognizes these stand-in answers.

**People.** `confirm()` and `prompt()` send `askPerson` to `DialogBroker`
and wait (with a 10 minute stall timer that the broker's heartbeats keep
resetting). With no DialogBroker they fail closed: `confirm()` returns
`false`, `prompt()` returns `null`. `awaitingHuman(what, taskId?)` sends a
`progress` heartbeat every 2s so callers behind a dialog do not time out;
call the returned stop function in a `finally`.

**Other helpers.** `askDecision()` and `decisionSiteMode()` (decision model
via `LLM.decide`, see `decision-sites.ts`); `notify()` (toast through
NotificationCenter, a no-op when absent); `fetchTheme()` plus automatic
`themeChanged` / `activeThemeChanged` tracking into `this.theme`;
`playWindowEffect()` and `setWindowModal()`; `logDebug/Info/Warn/Error()` to
the workspace Console (never throws); `setTimer()`, `setRecurringTimer()`,
`cancelTimer()` (timers that `stop()` cancels, preferred over raw
`setTimeout` for anything that sends); `resolveCallerName()` /
`resolveCallerIdentity()` (who sent this, from the Registry: name, typeId,
`builtIn`) and `isBuiltInCaller()` (the admission check privileged handlers
make);
`capabilityCaller()` and `requireTaskRuntime()` (recover the real caller
behind JobManager or AgentAbject); `retainTaskResult()` / `takeTaskResult()`.

## Files

### Object model and messages

- **abject.ts**: `Abject`, `SimpleAbject`, `DEFERRED_REPLY`,
  `isTemporaryAskResponse()`, `MessageHandlerFn`, `AbjectOptions`. See above.
- **types.ts**: all shared types. Ids (`AbjectId`, `TypeId`, `InterfaceId`,
  `MessageId`, `AgreementId`, `PeerId`), the envelope
  (`AbjectMessage` = `header` + `routing` + `payload` + `protocol`;
  `MessageType` is `request | reply | event | error`), `AbjectError`,
  interface declarations, `AbjectManifest` (with `lineage`,
  `icon`, `sharing: SharingPolicy`), `ProtocolAgreement`, `AbjectStatus`,
  registry types (`ObjectRegistration`, `ObjectSummary`, `DiscoveryQuery`),
  and `SpawnRequest` / `SpawnResult`. WASM ABI types live in
  `src/sandbox/wasm-abi.ts`.
- **built-in.ts**: which objects the system trusts. `isBuiltInRegistration()`
  (a registration with no source, no package owner, no remote peer: an
  instance of a server class) and `BOOTSTRAP_SENDER_ID`, the sender the
  bootstrap uses. Used by `Abject.isBuiltInCaller()`, the Factory and the
  registries.
- **contracts.ts**: `require`, `ensure`, `invariant`, `requireDefined`
  (returns the narrowed value), `requireNonEmpty`, `requireNonEmptyArray`,
  `requirePositive`, `requireNonNegative`. Each throws `ContractViolation`
  with `type` set to `require`, `ensure` or `invariant`. Always enabled.
- **message.ts**: builders `request()`, `reply()`, `event()`, `error()`,
  `errorFromException()` (lifts an embedded `CODE: ` prefix back into the
  error code instead of stacking `UNHANDLED_EXCEPTION`); guards `isRequest`,
  `isReply`, `isEvent`, `isError`, `isReplyTo`; JSON `serialize` /
  `deserialize`; `validateMessageShape()` (also used by the binary wire
  codec); per-sender sequence numbers with `resetSequence()`, which the bus
  calls on unregister.
- **introspect.ts**: `IntrospectResult`, `INTROSPECT_METHODS`
  (`getResultContract`, `describe`, `ask`, `getRegistry`),
  `INTROSPECT_EVENTS` (`childReady`, `changed`), and
  `formatManifestAsDescription()`, the plain-text manifest that `describe`,
  `ask` and the code generators read. Meta methods are filtered out of it.
- **protocol-description.ts**: `describeMessages(manifest, methods)` appends
  declarations for methods the manifest does not list yet (objects that build
  their manifest with an empty method list and describe it afterwards), plus
  `protocolText` / `protocolNumber` / `protocolObject` type shorthands. A
  parameter key ending in `?` is optional.
- **result-contract.ts**: `ResultContract` (`successField`, `errorField`) and
  `domainFailure()`. A method declares how its own result signals failure;
  callers learn it through the built-in `getResultContract` request.
- **permission-outcome.ts**: `PermissionReceipt` (evidence produced by the
  object that owns an operation), `PermissionDenied` (code
  `PERMISSION_DENIED`, receipt in `details`), `errorDetails()`.

### Identity, encoding, ownership

- **identity.ts**: peer identity crypto on WebCrypto. `PeerId` is the hex
  SHA-256 of the ECDSA P-256 public signing key (raw export). JWK
  import/export for signing and ECDH P-256 exchange keys,
  `derivePeerId()` / `derivePeerIdFromJwk()`, `deriveSessionKey()` (ECDH to
  AES-256-GCM), `aesEncrypt` / `aesDecrypt` (base64) and `aesEncryptBytes` /
  `aesDecryptBytes` (raw bytes for hot paths). Also `PeerIdentity`,
  `PeerContact`, `PeerConnectionState`.
- **encoding.ts**: base64, base64url, hex, UTF-8 as base64url, and
  `randomToken()`. Runs in Node, workers and the browser client (uses `Buffer`
  when present).
- **packages.ts**: package ownership. Script-package abjects are spawned with
  owner `package:<name>` (`packageOwner()`, `isPackageOwner()`,
  `packageNameOf()`); their data lives under `packageDataKey(type)` =
  `package/<Type>`.

### Concurrency, logging, formatting

- **keyed-lock.ts**: `withKeyedLock(key, fn)`: callers with the same key run
  one at a time, different keys run concurrently. In-process and cooperative.
  Derive the key synchronously before calling. `heldLockCount()`,
  `isLockHeld()`.
- **file-mutation-queue.ts**: `withFileMutationQueue(path, fn)` serializes
  writes to the same real file (symlinks resolved synchronously) on top of
  `keyed-lock.ts`. Reads do not queue. `pendingMutationCount()`.
- **bounded.ts**: `runBounded(count, limit, fn)` runs `fn(0..count-1)` with at
  most `limit` in flight (boot-time restores).
- **timed-log.ts**: `Log` (alias `TimedLog`): `new Log('TAG')` with `info`,
  `warn`, `error` stamped with time since process start, and `timed()` /
  `summary()` for step profiling.
- **format.ts**: `safeStringify(value, maxLen?)`, which never throws and never
  returns `undefined`.

### Host files, shell and sandboxed code

All but `file-edit.ts` and `tool-output.ts` import Node built-ins (`fs`,
`path`, `os` or `vm`), so they run on the backend only.

- **command-analysis.ts**: parses a shell command line into the commands it
  really runs, classifies each (`read`, `write`, `exec`, `network`,
  `dangerous`), and reports touched paths. Unknown programs are `exec`;
  anything it cannot reduce with confidence is `opaque`. Pure code, no LLM.
  `analyzeCommand`, `checkContainment`, `pathsOutside`, `protectedWrites`,
  `isSensitivePath`, `redactCommand`, `isCredentialVarName`,
  `describeAnalysis`. Used by PermissionBroker and ShellExecutor.
- **path-scope.ts**: `expandHome`, `isInside` (boundary-correct, so
  `/a/project` does not contain `/a/project-secrets`), `isInsideAny`,
  `deepestContaining`. String arithmetic only.
- **physical-path.ts**: `physicalPath()` resolves symlinks in existing
  ancestors (and dangling links) so a new file cannot escape a grant;
  `physicalGrantRoots()` drops grants that cannot be resolved. Uses
  `original-fs` under Electron.
- **ignore-rules.ts**: a small `.gitignore` matcher (`IgnoreSet`) and
  `ALWAYS_IGNORED_DIRS` for directory walks. Rules it does not understand
  never match, so walks get broader, not narrower.
- **file-edit.ts**: `applyEdits(original, edits)` applies a set of exact-text
  replacements as one transaction: every `oldText` is matched against the
  original and must be unique and non-overlapping, or nothing is applied.
  Returns a diff. `formatEditFailures()`.
- **tool-output.ts**: one truncation contract for bulk text handed to agents:
  `truncateHead` (file reads) and `truncateTail` (command output), line and
  byte budgets (`DEFAULT_MAX_LINES` 2000, `DEFAULT_MAX_BYTES` 50 KB),
  `continuationNotice`, `droppedNotice`, `formatSize`.
- **sandbox.ts**: Node `vm` sandbox for untrusted JavaScript.
  `SANDBOX_BUILTINS` / `SANDBOX_BUILTIN_NAMES`, `BLOCKED_CODE_PATTERNS` +
  `validateCode()`, `runSandboxed()` (async body) and `compileSandboxed()`
  (handler-map object expression, used by ScriptableAbject). Also used by
  JobManager and TriggerManager.

### Agents, goals and decisions

- **decision-sites.ts**: every named call point where the system asks a
  decision model to judge (`DECISION_SITES`, ids like `agent.progress`,
  `chat.route`, `scrum.quick-dispatch`), each with a mode (`advise` or
  `act`) and an emulation rule. `DecisionPolicy` (global gates on/off plus
  per-site overrides), `DEFAULT_DECISION_POLICY`, `capMode()`,
  `resolveSiteMode()`.
- **decision-questions.ts**: shared question builders for those judgments
  (`progressQuestions`, `failureQuestions`, `completionQuestions`,
  `interjectionQuestions`, and others) plus `criterion()` / `instruction()`
  for writing new ones. Builders stay generic: no object or agent names.
- **claims.ts**: cheap regex reads of agent reports: `looksLikeClaim`,
  `looksLikeAbsenceClaim`, `hasEvidenceMarkers`, `looksLikeUngroundedClaim`,
  `looksLikeBareAcknowledgement`. They route text to a second look, they are
  not verdicts. Used by Chat and ScrumMaster.
- **task-graph.ts**: UI-agnostic reading of a round's task DAG for the
  scheduler, the goal widgets and the CLI: `isSatisfied`, `isTerminal`,
  `blockedOn`, `indexById`, `orderTopologically`,
  `transitiveDependentCounts`, `deriveContractEdges` (edges implied by
  produces/consumes keys), `validateDataFlow`.
- **conversation-context.ts**: the bounded chat history a goal carries
  (`captureConversation`, at most 40 messages), `conversationBriefing()` for
  prompts, `identifyMessages()`, `CONVERSATION_CONTEXT_KEY`.
- **agent-session-codec.ts**: `encodeAgentState` / `decodeAgentState`: JSON
  persistence that keeps `Map` and `Set` and drops promises, functions and
  deferred messages.

### Knowledge and learning

- **knowledge.ts**: the message vocabulary of the KnowledgeBase, which is the
  C++/WASM package in `native/knowledge-base` (there is no TypeScript
  KnowledgeBase). `KNOWLEDGE_BASE_ID`, `PROFILE_TAG`, `KnowledgeEntry`,
  `KnowledgeType` (`learned`, `fact`, `insight`, `reference`, `pattern`),
  `KnowledgeOrigin`.
- **learning.ts**: durable learning decisions and effects
  (`LearningDecision`, `LearningEffect`, `KnowledgeLearning`),
  `validateLearningEffect()` (the accepted knowledge dispositions such as
  `save_entry`, `supersede_entry`, `record_pattern_application`),
  `canonical()` and `learningFingerprint()`.
- **pattern.ts**: the structured pattern-language entry (`PatternBody`:
  context, forces, therefore, evidence, links, ...) stored as JSON and
  rendered for people. `makePattern`, `serializePattern`, `readPattern`,
  `renderPatternText`, `patternSearchText`, `normalizeLinks`, and
  `parseLegacyPatternText` for old prose entries.
- **plan-patterns.ts**: reads the patterns a goal's recorded plan revisions
  declare (`declaredPatterns`, `planPatternIds`, `planPatternTrail`), so
  ScrumMaster (declares) and TaskReviewer (judges) agree.

### Skills and MCP

- **skill-types.ts**: `SkillInfo`, `MCPServerMeta`, `SkillConfig`,
  `EnabledSkillSummary`.
- **skill-parser.ts**: `parseSkillMd()` for SKILL.md files (YAML frontmatter
  plus instructions), detecting Claude Code, OpenClaw and MCP flavors.
- **skill-synth.ts**: turns an MCP registry package into a local SKILL.md
  (`packageToMcpCommand`, `sanitiseSkillName`, `buildMcpSkillMd`).
- **host-mcp-import.ts**: finds MCP servers already configured on the host
  (mcporter for commands, openclaw for credentials) and synthesizes SKILL.md
  files for them (`discoverHostMcpServers`, `synthesizeHostSkillMd`).
- **mcp-types.ts**: JSON-RPC 2.0 and MCP request/response types.
- **mcp-format.ts**: renders MCP tool definitions as prompt text
  (`formatMCPTool`, `formatMCPToolList`, `formatMCPInputSchema`).

### Shared UI data (no drawing)

- **theme-data.ts**: `ThemeData` and its design tokens, the built-in theme
  presets (`DEFAULT_THEME` is Red Sigil), `BUILTIN_THEME_PRESETS`,
  `getBuiltinThemeById`, `fillThemeDefaults`, `shapeOf`. Lives in core so
  `Abject` can hold a theme without importing widget code.
- **dock-layout.ts**: `SIDEBAR_WIDTH` and `SIDEBAR_COMPACT_WIDTH`, shared by
  the Sidebar and WorkspaceManager so WorkspaceManager (which runs headless
  too) does not import the Sidebar.

## Writing an Abject

```typescript
import { Abject } from '../core/abject.js';
import { AbjectId, AbjectMessage, InterfaceId } from '../core/types.js';
import { require as contractRequire, invariant } from '../core/contracts.js';

export const GREETER_ID = 'abjects:greeter' as AbjectId;

export class Greeter extends Abject {
  private greetings = 0;

  constructor() {
    super({
      manifest: {
        name: 'Greeter',
        description: 'Greets people by name.',
        version: '1.0.0',
        interface: {
          id: 'abjects:greeter' as InterfaceId,
          name: 'Greeter',
          description: 'Greetings',
          methods: [{
            name: 'greet',
            description: 'Return a greeting',
            parameters: [{ name: 'name', type: { kind: 'primitive', primitive: 'string' }, description: 'Who to greet' }],
            returns: { kind: 'primitive', primitive: 'string' },
          }],
        },
        tags: ['system'],
      },
    });
    this.on('greet', (msg: AbjectMessage) => {
      const { name } = msg.payload as { name: string };
      contractRequire(typeof name === 'string' && name.length > 0, 'name required');
      this.greetings++;
      this.checkInvariants();
      return `Hello, ${name}`;               // becomes the reply
    });
  }

  protected override checkInvariants(): void {
    super.checkInvariants();
    invariant(this.greetings >= 0, 'greetings must be non-negative');
  }
}
```

Async setup (discovering dependencies with `discoverDep()` or `requireDep()`)
goes in `protected override async onInit()`, cleanup in `onStop()`. Another
object calls it with
`await this.request<string>(request(this.id, greeterId, 'greet', { name: 'Ada' }))`
(`request` from `message.ts`).
To make it a running system or workspace object, register its constructor and
spawn it as described in the root `CLAUDE.md` (bootstrap in `server/boot.ts`,
worker tables in `workers/core-constructors.ts`).

## Adding to core

- Put something here only when several modules must agree on it, or when it
  must be importable from places that cannot pull in objects (the browser
  client, the CLI, worker entry points).
- Keep it workspace-agnostic and display-free. Headless bundles are checked
  for UI modules (`scripts/headless-bundle-check.mjs`), so shared numbers or
  data a UI object also needs belong in a plain module here (as
  `dock-layout.ts` does), not behind an import of the UI object.
- New behavior every Abject needs (a discover-then-send helper, say) goes on
  `Abject` as a protected method; facts about the environment (display,
  edition) come from an owning object by message, not from a base-class
  helper.
- Export it from `src/index.ts` if it is public API.

## Gotchas

- **Handlers run concurrently.** The processing loop calls each handler and
  does not await it, so two async handlers on one object interleave at every
  `await`. Guard read-modify-write state with `withKeyedLock()`.
- **`request()` takes a message, not arguments:**
  `this.request(request(this.id, to, 'method', payload), timeoutMs)`.
- **Timeouts are stall timers.** Long work stays alive by sending `progress`
  events; a deferred handler keeps the caller reachable for progress until
  `sendDeferredReply()` runs.
- **Built-in handlers overwrite yours.** `init()` registers `describe`,
  `ask`, `addDependent`, `removeDependent`, `getRegistry` and
  `getResultContract` after your constructor; customize `ask` through
  `askPrompt()`, `askTier()` or `handleAsk()`.
- **`require` shadows Node's `require`.** Many files import it renamed:
  `import { require as contractRequire } from './contracts.js'`.
- **`changed()` sends two events per dependent.** Handle either `changed` or
  the per-aspect event, never both.
- **Use managed timers.** A raw `setTimeout` that calls `send()` after
  `stop()` throws from a timer callback with no caller to catch it; use
  `setTimer()` / `setRecurringTimer()`.
- **Sequence numbers are module state** in `message.ts`; call
  `resetSequence()` in tests that reuse sender ids.
- Imports always use the `.js` extension.

## Related

- [../runtime/README.md](../runtime/README.md): MessageBus, Mailbox, workers, Supervisor
- [../protocol/README.md](../protocol/README.md): Negotiator and HealthMonitor
- [../objects/README.md](../objects/README.md): the system objects built on `Abject`
- [../sandbox/README.md](../sandbox/README.md): WASM and script packages
- [../../docs/WASM_ABI.md](../../docs/WASM_ABI.md), [../../docs/PACKAGES.md](../../docs/PACKAGES.md)
