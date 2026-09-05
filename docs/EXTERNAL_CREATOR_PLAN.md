# ExternalCreator — an on-disk authoring agent for Abjects

Status: **implemented** (Phases 0–3 and 5). Phase 4 is the dogfood milestone,
which is yours to run. This document is the design record; see
§7 for what landed where.

Revision 5 — merges the second plan's gating and transactional ideas;
settles the workspace / external-project vocabulary; drops the assumption that
every external project is a coding project; adds opt-in worktree isolation.

Goal: work on Abject (and other projects) from inside Abject. ObjectCreator
authors Abjects; ExternalCreator authors files on the host filesystem, runs
whatever checks the project declares, and reports what it verified. Its heaviest
use is software, but nothing in it assumes the files are code.

---

## 1. Research

### 1.1 What ObjectCreator actually is

`src/objects/object-creator.ts` (3822 lines) is a ReAct agent registered with
`AgentAbject`. Its shape:

| Layer | ObjectCreator |
|---|---|
| Workspace | the live Registry (objects, not files) |
| "File" | one handler-map source string per object |
| Navigation | `read_draft` (outline / member / lineRange / grep) |
| Mutation | `edit_source` with an all-or-nothing edit set (`replace`/`add`/`remove`/`diff`), `more: true` to keep a set open across turns |
| Compiler | acorn parse + `validate_calls` (does this dep actually have that method?) + LLM `review_semantics` |
| Ship | `deploy_spawn` / `deploy_update` — the gate; a draft that fails parse or call-validation is refused |
| Verify | behavioral: `call` the deployed object and check the response |
| Prompt | ~200 lines teaching an invented world |

The best ideas in it are transferable and mostly not about Abjects:

- **Checks run themselves.** The agent is explicitly told *not* to spend steps
  compiling. The verdict rides back on the same action that made the edit.
- **Deploy is the gate.** You cannot ship broken code, so defensive checking is
  wasted budget.
- **Two-tier verification.** Parse and call-validation are hard blockers; the
  LLM semantic review is advisory and rides back as notes. Never confuse them.
- **All-or-nothing edit sets.** Four methods is one action, not four.
- **`more: true`.** Keeps a multi-turn edit set open so half-written code is not
  judged.
- **State the object writes is a claim, not evidence.** Verify against something
  the code cannot fabricate.
- **`expect` predictions.** Commit to an outcome before acting; a miss localizes
  which belief is wrong.

The parts that do *not* transfer: manifests, organisms, the sandbox runtime
warnings, the ask protocol as the only discovery mechanism. Roughly 60% of that
200-line prompt is world-teaching that is pure overhead outside Abjects.

### 1.2 What already exists in this repo for native dev

| Piece | Where | State |
|---|---|---|
| `ShellExecutor` | `capabilities/shell-executor.ts` | `exec` (shell + execFile modes), per-object command grants, permission-authority prompts, skill env, `getPlatformInfo` |
| `HostFileSystem` | `capabilities/host-filesystem.ts` | `readFile` (offset/limit), `writeFile`, `editFile`, `glob`, `grep`, `stat`, `mkdir`, `readdir`, `exists`, `deleteFile`; path allowlist + readOnly |
| Agent runtime | `agent-abject.ts` (4485 lines) | observe→think→act, multi-action batching, payload handles + `read_chunk`/grep, `expect` predictions, oscillation steering, step-budget extensions, LLM-backed conversation compression, prompt-cache breakpoints, tiering, skill/KB injection, per-agent queues |
| Dispatch | `scrum-master.ts` | polls `listAgents`, then `ask`s each agent whether it can do the task; `quick_dispatch` for single-step goals |
| Closest sibling | `skill-agent.ts` | already advertises "host shell execution … git, pytest, gh" |

**Gaps that matter.** These are the reasons a naive "point ObjectCreator at
files" would perform badly:

1. `HostFileSystem.readFile` returns the **whole file** with no cap. One read of
   `agent-abject.ts` is ~180KB — it blows the conversation budget in one action.
2. `HostFileSystem.editFile` uses `replaceAll` with **no uniqueness check** and
   no multi-edit. A common substring silently rewrites the file everywhere.
3. `glob`/`grep` are hand-rolled walks with **no .gitignore awareness** — they
   walk `node_modules`, `.git`, `dist`.
4. `ShellExecutor.exec` applies **no output truncation**. `pnpm build` output
   goes into the conversation verbatim.
5. There is **no cwd / project concept anywhere in the system.**

### 1.3 What pi.dev does (and why it wins on cost)

Source read: `earendil-works/pi`, `packages/coding-agent`. Databricks' internal
benchmark reportedly put pi at the top pass rate on Opus 4.8/xhigh at
significantly lower cost than Claude Code and Codex, attributed to sending
~3x less context per turn.

**1. The system prompt is ~30 lines.** Verbatim opening:

> You are an expert coding assistant operating inside pi, a coding agent
> harness. You help users by reading files, executing commands, editing code,
> and writing new files.

Then a tool list, a handful of guidelines, and `Current working directory: …`.
That is the whole thing. The model already knows Node, TypeScript, git, and
pnpm better than any prompt we can write. Behavior lives in **per-tool**
`promptSnippet` + `promptGuidelines`, assembled only for the tools actually
enabled — so the prompt shrinks when the tool set shrinks.

**2. Four tools: `read`, `bash`, `edit`, `write`.** Optional read-only extras
(`grep`, `find`, `ls`). Everything else is bash.

**3. `edit` takes an array.** Each `oldText` is matched against the **original**
file (not incrementally), must be unique, must not overlap another edit in the
same call. Its guidelines are worth copying almost verbatim:

> Keep edits[].oldText as small as possible while still being unique in the
> file. Do not pad with large unchanged regions.

**4. One truncation contract everywhere: 2000 lines or 50KB, whichever hits
first.** `read` truncates head and appends
`[Showing lines 1-2000 of 5312. Use offset=2001 to continue.]`. `bash`
truncates tail and spills full output to a temp file whose path is returned.
`read` returns **no line numbers** — edits are addressed by text, so the number
column would be dead weight.

**5. Context files.** `AGENTS.md` / `CLAUDE.md` are discovered from the cwd
chain (with `AGENTS.override.md` shadowing) and injected as
`<project_instructions path="...">`. Project knowledge lives there, not in the
agent's prompt.

**6. Skills are progressive disclosure.** Only name + description sit in the
prompt; the model `read`s the full `SKILL.md` when a task matches.

**7. Compaction produces a structured, iteratively-updated summary**, not prose:

```
## Goal
## Constraints & Preferences
## Progress   (### Done / ### In Progress / ### Blocked)
## Key Decisions
## Next Steps
## Critical Context
```

plus explicitly tracked `<read-files>` and `<modified-files>` lists carried
across every compaction, and an update prompt that says PRESERVE existing
information, move items In Progress → Done, preserve exact paths and errors.

**8. Project trust.** Before a trust decision, pi loads only global config;
project-local extensions and settings load *after* the directory is trusted.

**9. Sessions are append-only trees** (`id`/`parentId`), so any point is
forkable. Extensions layer on top: `git-checkpoint.ts` (a `git stash create`
ref per turn), `protected-paths.ts`, `confirm-destructive.ts`,
`dirty-repo-guard.ts`, `plan-mode`, `handoff.ts`.

**10. Deliberately absent:** no read-before-edit gate, no mtime staleness check,
no default bash timeout.

### 1.4 The synthesis

> ObjectCreator's fat prompt is correct **because** it teaches a world the model
> has never seen. Outside Abjects the model already knows the world, so the same
> prompt style is pure cost. Take ObjectCreator's **discipline** (checks run
> themselves, ship-is-the-gate, hard-vs-advisory tiering, all-or-nothing edit
> sets, evidence over claims) and pi's **economy** (tiny prompt, small tool
> kernel, one truncation contract, project context in files).

---

## 2. Vocabulary: workspace, external project, and the word "project"

"Project" is the ambiguous word, so it needs a qualifier on at least one side of
the runtime boundary:

- **Workspace** — your project *inside* Abject. A named scope holding objects,
  with its own Registry, KnowledgeBase, and privacy boundary.
- **External project** — your project *outside* Abject. A named directory on the
  host holding files: source, prose, notes, data, design assets, whatever the
  work is made of.

Both are "a project" in ordinary speech, which is why the Abject is
`ExternalProjectRegistry` and not `ProjectRegistry`. Someone reading **Projects**
in a sidebar next to **Workspaces** would reasonably assume they are the same
list, and an agent reading "the project" in a shared prompt has no way to tell
which side of the boundary it is on.

Inside ExternalCreator's own prompt the qualifier can drop — everything it
touches is external, so "Project: <name> at <root>" is unambiguous there. The
qualifier earns its keep on shared surfaces: the UI sidebar, the Registry,
KnowledgeBase prompts, and ScrumMaster routing.

**Not a coding concept.** An external project is a named directory with a
description and, optionally, commands that check and verify it. Nothing in the
action kernel (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`) assumes
code — that is precisely pi's point about a minimal orthogonal tool set. A book
manuscript with a `vale` lint and a `pandoc` build is an external project on the
same terms as a TypeScript service; a folder of research notes with no commands
at all is one too, and §3.4 says exactly what the gate does when there is
nothing to run.

The two domains are structurally parallel, and that parallel is itself the
argument for not adding a project layer over internal objects — every column
already has a name:

| Concern | Workspace (inside) | External project (outside) |
|---|---|---|
| Scope | the workspace | the project root |
| Unit of work | an Abject | a file |
| Index | Registry (`discover`, `resolveType`) | filesystem + git |
| Addressing | `typeId` = `{peer}/{ws}/{name}` | path relative to root |
| Conventions | `ask` protocol + KnowledgeBase | `CLAUDE.md` / `AGENTS.md` |
| Verification | deploy gate + behavioral `call` | whatever the project declares |
| Durability | AbjectStore snapshots + source ring | git, or nothing |

Grouping internal objects is already served by workspaces (scope), Organisms
(composition), and tags (classification). A "project" concept on top would
duplicate the workspace and the Registry.

**`ExternalProjectRegistry` is not ExternalCreator's private.** A named root with
a description is useful to FileManager, FileViewer, SkillAgent, Scheduler jobs,
and the `commune` CLI. ExternalCreator is its heaviest consumer, not its owner.
It is workspace-scoped like everything else, so a private workspace's projects
stay out of a public one.

**Fix the ambiguity in existing copy too.** `knowledge-base.ts:644` already tells
every agent to record "facts about the workspace or project structure",
conflating both senses in a prompt read on every task. Phase 0 sweeps strings
like that: inside the system it is a workspace, on disk it is an external
project, and bare "project" survives only where context already settles it.

**Names considered:**

| Candidate | Verdict |
|---|---|
| `ExternalProjectRegistry` / "external project" | **Recommended.** Your suggestion. Unambiguous next to Workspace, assumes nothing about what the work is, and the qualifier drops naturally inside ExternalCreator where everything is external. |
| `CodebaseRegistry` / "codebase" | Rejected: bakes coding into a concept the tool kernel does not assume. A manuscript or a notes folder is not a codebase. |
| `HostProjectRegistry` / "host project" | Close second, and it matches the existing `HostFileSystem` vs virtual `FileSystem` precedent. Loses to "external" only because it does not pair with `ExternalCreator`. |
| `RepoRegistry`, `CheckoutRegistry`, `WorktreeRegistry` | Too git-specific; not every root is a repo, and `worktree` collides with git's own term. |
| `ProjectRegistry` | The ambiguity that started this. |

**The agent's name is now settled by the noun.** `ExternalCreator` works on
external projects — one sentence, no gloss needed.

**The bridge case.** `~/projects/abjects` is an external project whose build
output *is* this system. A goal like "add a method to KnowledgeBase and prove it
works" spans both domains: ExternalCreator edits `.ts` and runs `tsc`/tests, then
a restart (human or Trigger) is needed, and only then can ObjectCreator or
ObjectAgent verify behavior in-system. Section 3.7 makes that handoff explicit
rather than pretending one agent closes the loop.

---

## 3. Proposal

Three pieces. Each single-purpose, per this repo's own rules.

### 3.1 `ExternalProjectRegistry` — the missing cwd (new, per-workspace INFRA)

```
src/objects/external-project-registry.ts
```

State per project: `name`, `root`, `description`, `vcs` (git / none),
`protectedPaths`, `trusted` (see below), and **optionally** `checkCommand`
(fast — `pnpm tsc --noEmit`, `vale`, a link checker), `verifyCommand`
(authoritative — build + tests, `pandoc`, a full render), `formatCommand`.

The commands are optional on purpose. A TypeScript service declares both; a
manuscript may declare only a lint; a folder of notes declares neither and is
still a first-class project. What the commands are is the project's business,
not this object's — it stores strings and runs them.

Methods: `addProject`, `removeProject`, `listProjects`, `getProject`,
`resolveProject(pathOrName)`, `updateProject`, `setTrusted`. Its `ask` answers
"which project is X?" and "how do I build X?".

Why an Abject rather than a settings field:

- It is the workspace-scoped privacy boundary this repo already requires.
- Registering a project is the natural moment to widen `HostFileSystem`'s
  `allowedPaths` and pre-grant `ShellExecutor` commands, so the user approves
  `pnpm` and `git` once per project instead of once per command line.
- ScrumMaster, Chat, and every file-touching object can ask it what exists.

**Project trust** (from pi, and the honest version of the second plan's
"path-keyed trust ledger"): a newly added project starts untrusted. Untrusted
means its `CLAUDE.md`/`AGENTS.md` are *not* injected into the prompt and its
scripts (`package.json` lifecycle hooks, `.envrc`) are not run — because those
are attacker-controlled text and code in any repo you did not write. The user
trusts a project once, explicitly, and it is recorded. This matters more than it
sounds: injected project instructions are prompt-injection surface.

A `ExternalProjectBrowser` UI object comes later, separately (Manager/Browser split).

### 3.2 Capability upgrades (additive, benefit every agent)

**`HostFileSystem`** — add, do not change existing semantics:

- `edit(path, edits[{oldText, newText}])` — each matched against the
  **original** content, each unique and non-overlapping, all-or-nothing, and it
  **returns a unified diff of what actually changed**. The diff is the evidence;
  the agent should read it rather than re-reading the file. `editFile`
  (`replaceAll`) stays for existing callers.
- Truncation on `readFile`: 2000 lines / 50KB head-truncation with the
  `Use offset=N to continue` notice. Oversized content returns through the
  runtime's existing `bulkAwareResult` payload handle, so the agent can
  `read_chunk` with grep instead of re-reading.
- `.gitignore`-aware `glob`/`grep`, byte/match caps, `-C` context lines, and an
  `ls` method with an entry cap.

**`ShellExecutor`** — add:

- Output caps (tail-truncate to 2000 lines / 50KB), overflow via the same
  payload-handle path.
- A default `cwd` resolved from the caller's active project.

**Decision to confirm: line numbers on `read`.** pi returns none (edits are
text-addressed); Claude Code numbers them. Recommendation: **no numbers on
`read`, numbers on `grep`**. Compiler and test errors arrive as `file:line`, and
`grep` is how you turn a line number into the unique text an `edit` needs.

### 3.3 `ExternalCreator` — the agent (new, per-workspace INFRA)

```
src/objects/external-creator.ts
```

Registers with `AgentAbject` as `ObjectAgent` does: `terminalActions: { done,
fail }`, `intermediateActions: ['reply']`, its own queue, `maxSteps` ~50 (file
work runs longer than object work; the runtime's progress-aware extensions
still apply). Local `LoopState` holds: active project, baseline snapshot, open
edit set, files read, files modified, last verify result.

**Action kernel.** Small and orthogonal:

| Action | Notes |
|---|---|
| `read` | path, offset?, limit? |
| `write` | path, content — atomic (temp + rename), rollback on failure |
| `edit` | path, edits[], `more?: true`; all-or-nothing; returns a diff |
| `bash` | command, cwd? (defaults to project root), timeout? |
| `grep` / `find` / `ls` | scoped to the project root |
| `verify` | runs the project's `checkCommand` or `verifyCommand` and records the result against the baseline (§3.4) |
| `call` | keeps the whole bus reachable — KnowledgeBase, GoalManager scratchpad, ExternalProjectRegistry, MCP-backed skills |
| `read_chunk`, `reply`, `ask_user`, `done`, `fail` | runtime-provided |

`verify` earns a named action rather than being "just bash" because the `done`
gate needs a canonical record of *what was verified and when* — a bash
invocation that happens to run tests is not distinguishable from one that does
not.

**System prompt: target 40 lines, hard ceiling 60.**

```
You are ExternalCreator. You work on real files on this host.
Project: <name> at <root>.  Check: <checkCommand>.  Verify: <verifyCommand>.
Baseline at task start: <N> pre-existing failures (you are not accountable for these).

Actions:  (one line each)

Guidelines:
- Keep edits[].oldText as small as possible while unique. Do not pad.
- One edit call with several entries beats several edit calls.
- Checks run themselves: <checkCommand> runs after every closed edit set and
  its verdict comes back on that same action. Do not spend a step running it.
- done is refused while you have introduced failures the baseline did not have.
- With no verify command declared, say plainly in your report what you checked
  and what you could not.
```

Everything else — conventions, build commands, architecture — comes from the
project's own `CLAUDE.md` / `AGENTS.md`, injected as
`<project_instructions path="...">` **before the cache breakpoint** (stable per
project, so it caches), and only for trusted projects.

**Boundary vs ObjectCreator**, stated in `askPrompt` so ScrumMaster routes
correctly: *ObjectCreator changes objects inside this system; ExternalCreator
changes files on disk in a registered external project and runs that project's own
tooling. Neither does the other's job.*

**Model tier.** Think on the existing `'code'` tier (falls back to `smart` when
unrouted), escalating to `smart` after a repeated failure — the policy
`ObjectAgent` already uses.

### 3.4 The gate: two tiers, baseline-relative

This is the part the second plan got right and my first draft got wrong. I had
`done` gated on `verifyCommand` exiting 0, which **deadlocks on any repo with a
pre-existing failing test** — including this one, most days.

**Baseline delta accounting.** At task start, snapshot the project's current
`checkCommand` (and, when cheap enough, `verifyCommand`) failures: the set of
`file:line:code` diagnostics and failing test ids. The agent is accountable only
for the *delta*. Reported as:

```
Baseline: 3 tsc errors, 2 failing tests (recorded at task start)
Now:      3 tsc errors, 2 failing tests, +1 new error in src/objects/foo.ts:88
```

**Tier 1 — mechanical, hard blockers.** New syntax errors, new type errors, new
failing tests, writes to protected paths. These block `done` and are stated as
exact locations, never as prose.

**Tier 2 — advisory.** LLM semantic review, lint style notes, pre-existing
failures. These ride back on the result and into the final report; they never
block. ObjectCreator already draws exactly this line and it is why its deploy
step does not stall.

**Cadence.** `checkCommand` runs automatically when an edit set closes (no
`more: true`) and its verdict attaches to that action's result — the direct port
of "checks run themselves". `tsc --noEmit --incremental` with a buildinfo file
in the scratchpad keeps this in the low seconds. `verifyCommand` runs at the
gate, before `done`.

**When a project declares no commands, the gate degrades, it does not vanish.**
There is nothing to run, so there is no delta to block on — but `done` still
requires the agent to state what it changed and what evidence it has, and the
absence of automated verification is reported as such rather than silently
reading as "verified". A project that gains a `checkCommand` later gains the hard
tier with it; that is the only difference between the two cases.

**Rollback.** If a closed edit set leaves a file that no longer parses, revert
that file to its pre-edit content, report the failing location, and keep the
loop alive. A file is never left broken by a mechanical failure; the agent gets
a location instead of a corpse. (Uses `write`'s atomic temp+rename plus a
per-task pre-image cache, not git.) Parse-checking applies to formats we can
cheaply parse — TS/JS, JSON, YAML, TOML, Markdown front matter — and is simply
skipped for the rest; an unparseable format is not an excuse to skip the write.

### 3.5 Durability, history, and safety

**Checkpoints, not branches.** `git stash create` at task start and after each
closed edit set: it produces a restorable ref **without touching the working
tree or the index**. Refs go into the task report so any point is one command
from being restored, and a failed refactor forks from a checkpoint rather than
being unwound by hand. This is the practical 80% of the second plan's
"append-only DAG with forking" at roughly none of the cost.

**No auto-commit, no feature branches.** The second plan proposed packaging
edits as commits on designated feature branches. That contradicts your standing
conventions (commit directly to main, and only when explicitly asked), so
ExternalCreator leaves changes in the working tree, reports the diffstat, and
commits only when the task says to.

**Audit log separate from LLM context.** Every action, its arguments, its exit
code, and its diff go to a per-task audit record (Console + AbjectStore); only
the compact rendering enters the conversation. Same substance as the second
plan's JSONL split, using storage this system already has rather than a new
on-disk format. (Storage is SQLite-backed now, so this is cheap.)

**Session continuity.** On task end, write pi's structured summary (Goal /
Constraints / Progress / Key Decisions / Next Steps / Critical Context) plus
`readFiles` / `modifiedFiles` and the baseline snapshot to the goal scratchpad
under `externalcreator:session`; reload it on the next task in the same goal.
ObjectCreator already does this shape with `objectcreator:staged-draft`.

**Path and command enforcement lives in the capabilities, not in the agent.**
`HostFileSystem.allowedPaths` + `protectedPaths` already own path containment;
`ShellExecutor`'s permission authority already owns command approval, per-object
grants, and shell-metacharacter detection. The second plan proposed a
`before_tool_call` / `after_tool_result` middleware pipeline inside the agent —
that would duplicate enforcement that already exists one layer down, in the only
place it can be enforced for *every* caller rather than for the one agent that
remembers to route through the hooks. Keep enforcement where it is; the agent
just gets clearer errors back.

### 3.6 Isolation: worktrees as an option, not a default

**pi does not use worktrees.** It only *detects* that it may be running inside
one: `resource-loader.ts` canonicalizes paths and dedups `AGENTS.md` discovery
across a linked worktree, because `git worktree add` writes `.git` as a *file*
and the main repo is not an ancestor of the worktree. Nothing in pi creates,
removes, or lists worktrees. Its isolation story is a different axis entirely —
micro-VM (Gondolin), Docker, or a policy sandbox, all of which isolate the
*process* rather than the branch — and its git extensions (`git-checkpoint.ts`,
`dirty-repo-guard.ts`, `git-merge-and-resolve.ts`) work in the checkout you
launched from.

That said, worktrees are genuinely the popular pattern for agent work, and for
good reasons that apply here more than they do to pi: this system is multi-agent
by construction, so two ExternalCreator tasks on the same repo would otherwise
fight over one working tree. The recommendation is a per-project `isolation`
field, defaulting to off:

| Mode | Behavior | Right for |
|---|---|---|
| `none` (default) | Work in the project root. Checkpoint with `git stash create` (§3.5). | The self-hosting loop, quick edits, anything needing build artifacts and local state to already be present. |
| `worktree` | `git worktree add` under a configured dir on branch `abjects/<goal-slug>`; the task runs entirely there; on `done`, report the branch and diff rather than merging. | Long autonomous tasks, parallel agents on one repo, anything the user does not want touching their tree. |

Why not default to `worktree`:

1. **Build artifacts do not come along.** A fresh worktree has no
   `node_modules`, `.venv`, `dist`, `target`, or `tsbuildinfo`. For this repo
   that means a `pnpm install` before `tsc` runs at all — turning a 3-second
   check into a multi-minute one, on every task. This is the real reason the
   pattern suits long autonomous runs and not small edits.
2. **Untracked local state does not come along** either: `.env`, `.abjects/`,
   SQLite files, local settings.
3. **It fights the self-hosting case.** You want ExternalCreator editing the
   checkout you are actually running (§3.7). Edits landing on a side branch have
   to be merged back before a restart shows anything.
4. **Landing needs commits.** Worktrees are only useful if work is committed on
   the branch, which collides with the standing no-auto-commit convention.
   In `worktree` mode that convention is relaxed *within the worktree branch*,
   since nothing there is on main and the branch is the deliverable.
5. **Not every project is git.** Isolation is unavailable for the rest, so the
   non-isolated path has to be first-class regardless.

Making `worktree` mode actually work needs two more optional registry fields,
both just strings the project declares about itself:

- `setupCommand` — run once after `git worktree add` (`pnpm install --frozen-lockfile`).
- `sharedPaths` — directories symlinked from the main checkout instead of
  rebuilt (`node_modules`, `.venv`). Cheaper than `setupCommand` and correct
  more often than it sounds, though not for every toolchain.

And a lifecycle rule, borrowed from how Claude Code's own worktree isolation
behaves: **remove the worktree on task end if it is unchanged**, keep it if it
has commits, and `git worktree prune` on registry init so abandoned runs do not
accumulate.

Worth noting that Abjects already has a parallelism boundary one level up —
workspaces isolate objects, KnowledgeBase, and registries. Worktrees are the
same idea projected onto disk, which is a decent argument for making the
mapping explicit later (a workspace's tasks default to that workspace's
worktree), but not for v1.

### 3.7 Self-hosting: the loop that does not close by itself

ExternalCreator editing `~/projects/abjects` from inside a running Abjects
instance is the intended use, and it works as long as the agent never restarts
its own host:

- Editing files and running `pnpm tsc --noEmit` / tests is safe — separate
  processes.
- **Restarting the backend is not the agent's job.** Its verification stops at
  typecheck + tests + this repo's own `verify` skill recipe (boot the server
  in-process and drive objects over the bus). That recipe is the strongest
  evidence obtainable without a restart, and it should be this project's
  `verifyCommand` here.
- The handoff for the bridge case is explicit: ExternalCreator reports
  "verified statically, needs restart to verify behaviorally", a human (or later
  a Trigger) restarts, and ObjectAgent/ObjectCreator verifies in-system. Do not
  let one agent claim the whole loop.
- Run it from the secondary instance against the primary checkout, so a bad edit
  cannot take down the instance doing the editing.

---

## 4. Considered and not adopted

Recorded so we do not re-litigate these.

**AST / tree-sitter symbol editing (`edit_symbol`).** ObjectCreator needs
member-addressed edits because its "file" is a single object literal with no
stable line numbers, and re-emitting the whole source gets truncated by output
limits. Real files do not have that problem: they have paths, line ranges, and
grep. Text-addressed multi-edit with a uniqueness check covers the same ground,
is language-agnostic, and adds no parser dependency per language. Revisit only
if measured edit-failure rates justify it — that is a data question, not a
design one.

**A middleware hook pipeline inside the agent.** Enforcement belongs in the
capability objects, where it already is and where it covers every caller
(§3.5). A hook layer in one agent is both a duplicate and a false sense of
safety.

**Append-only JSONL session DAG per repo.** Replaced by git checkpoints
(restore/fork) plus the audit-log split (history) plus the goal scratchpad
(resumption). Those three cover the use cases without inventing a new on-disk
format alongside AbjectStore.

**Feature-branch packaging and auto-commit.** Contradicts your standing git
conventions.

---

## 5. Phasing

**Phase 0 — foundations.** `ExternalProjectRegistry` (with trust); the
workspace / project string sweep (§2); `HostFileSystem` multi-edit + diff
output + truncation + gitignore-aware glob/grep/ls;
`ShellExecutor` output caps + default cwd. No agent yet; every existing agent
improves immediately.

**Phase 1 — agent shell and kernel.** The `ExternalCreator` Abject, registered
in `server/index.ts` **and** `workers/abject-worker-node.ts` **and**
`INFRA_OBJECTS`; the action kernel; the short prompt; project-context injection
for trusted projects; `askPrompt` boundary.

**Phase 2 — the gate.** Baseline snapshot and delta accounting; auto-`check` on
closed edit sets; hard-vs-advisory tiering; `done` gated on the delta;
parse-failure rollback.

**Phase 3 — durability.** git checkpoints, protected paths, audit/context split,
structured session summary in the goal scratchpad, read/modified file tracking,
and opt-in `worktree` isolation with `setupCommand` / `sharedPaths` and the
prune-on-exit lifecycle (§3.6).

**Phase 4 — dogfood milestone.** Concrete acceptance test on
`~/projects/abjects` from the secondary instance:

> "Add a `countByTag` method to KnowledgeBase, with contracts, and prove it
> typechecks and that the existing verify recipe still passes."

Success is: correct edit, `tsc` clean relative to baseline, verify recipe green,
a report naming the exact commands and exit codes, a checkpoint ref, and an
honest "needs restart for behavioral verification".

**Phase 5 — ergonomics.** `ExternalProjectBrowser` UI; parallel read-only
exploration sub-tasks via JobManager; KnowledgeBase patterns for per-project
conventions (TaskReviewer already mines these).

A non-code acceptance case belongs alongside Phase 4, since the whole point of
the vocabulary is that it exists: register a prose project with a `vale` check
and no build, have ExternalCreator make a substantive edit across several files,
and confirm the report is honest about what was and was not verified.

---

## 6. Open questions for you

1. **Line numbers on `read`** — recommendation: none on `read`, numbers on
   `grep`. Confirm or overrule.
2. **Baseline scope** — snapshot `checkCommand` only (fast, ~seconds), or the
   full `verifyCommand` (accurate, could be minutes at task start)?
   Recommendation: `checkCommand` always, `verifyCommand` lazily on first use
   and cached for the goal.
3. **Does ExternalCreator get `call`?** Recommendation: yes. Three lines of
   prompt, and dropping it would make ExternalCreator the one agent that cannot
   talk to the system it lives in.
4. **Phase 0 blast radius** — `HostFileSystem.readFile` gaining truncation
   changes behavior for existing callers (FileViewer, FileManager, SkillAgent).
   Opt-in via a `maxLines` parameter, or change the default and fix callers?
   Recommendation: change the default; unbounded reads are a latent bug
   everywhere.
5. **Worktree isolation** — ship `isolation: none | worktree` in Phase 3 as
   proposed, or defer worktrees entirely until a real parallel-agent workload
   asks for them? Recommendation: ship it, default `none`. The cost is one
   registry field and a create/prune helper, and the first time two goals touch
   the same repo simultaneously you will want it already there.
6. **Project trust default** — should a project added by the *user* through the
   UI be trusted immediately (they chose it), with only agent-added projects
   starting untrusted? Recommendation: yes.
7. **`sharedPaths` vs `setupCommand`** for worktree mode — symlinking
   `node_modules` is fast but wrong for some toolchains; a real install is
   correct but slow. Recommendation: support both fields, let each project
   declare what it needs, and start with `setupCommand` for this repo.

---

## 7. What landed

### New files

| File | What it is |
|---|---|
| `src/core/tool-output.ts` | The one truncation contract: 2000 lines / 50KB, head for reads, tail for command output, plus the continuation and dropped-line notices. |
| `src/core/ignore-rules.ts` | A .gitignore matcher (comments, negation, anchoring, dir-only, `*`/`?`/`**`) plus the always-skipped build directories, so walks stop wading through `node_modules`. |
| `src/core/file-edit.ts` | Exact-text multi-edit as one transaction: unique-match and overlap validation up front, all-or-nothing application, diff hunks out. |
| `src/objects/external-project-registry.ts` | The named on-disk work areas. Roots, descriptions, optional commands, protected paths, isolation mode, trust. |
| `src/objects/external-creator.ts` | The agent: action kernel, baseline delta accounting, auto-check, rollback, checkpoints, worktree isolation, session summary, the gate. |
| `src/objects/external-project-browser.ts` | The window: list, add, edit commands, trust, remove. |

### Changed files

| File | Change |
|---|---|
| `src/objects/capabilities/host-filesystem.ts` | Added `edit` (multi, transactional, returns a diff), `ls`, `grantPath`. Bounded `readFile` with a continuation notice and a `maxBytes: 0` escape. Made `glob`/`grep` gitignore-aware with caps, context lines, and case folding. All writes now go through an atomic temp+rename. |
| `src/objects/capabilities/shell-executor.ts` | Bounded `exec` output (tail-kept, stderr budgeted first) with a `truncated` summary, and added per-caller `setDefaultCwd`. |
| `src/objects/knowledge-base.ts` | The workspace / external-project string sweep. |
| `server/index.ts`, `workers/abject-worker-node.ts`, `src/objects/workspace-manager.ts`, `src/index.ts` | Registration in all four required places. |

### Decisions made during implementation

- **The gate runs at the task boundary, not inside the loop.** `AgentAbject`
  finishes a task the moment it parses a terminal action, so there is no hook
  between "the model said done" and "the task is done". ExternalCreator
  therefore enforces the gate on the way out: an unverified `done` is downgraded
  to a failure carrying the precise reason, so a caller never receives a claim
  that did not survive the check. In-loop the same verdict is stated in every
  observation once files have changed, so the refusal is never a surprise.
- **`grantPath` grants nothing by itself.** It runs the same permission prompt
  any access would; it only moves the question to a moment when the user has
  context. Shell commands still go through the existing per-object grants, so
  the first `pnpm` or `git` prompts once and can be allowed for this agent.
- **Parse-failure rollback is narrow on purpose.** Only a file this task just
  edited, and only when the new failure reads as a syntax error in that file. A
  type error is a real finding to work on; an unparseable file is noise that
  hides everything else the check would have said.
- **The session summary is assembled, not generated.** File lists, commands, and
  exit codes are facts this object already holds. Building the summary from them
  costs no LLM round-trip and cannot hallucinate a step that never happened.
