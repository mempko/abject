# Agent harness review: ExternalCreator, ObjectCreator, ScrumMaster

Date: 2026-09-04, plan revised and implemented the same day. Status: every item in section 4 is implemented in the working tree (uncommitted); typecheck passes; the headless boot and goal-pickup check passes; the verdict, attribution, edit-hint and claim logic were exercised with a one-shot script.

Scope: the three agents named in the title plus the runtime they all run on
(`AgentAbject`, 4753 lines), because most of what makes an agent harness strong
or weak lives in the loop, not in the agent. Compared against Claude Code,
OpenAI Codex CLI, OpenCode, pi, and xAI's Grok Build / Grok Bot as of
September 2026, plus three research results that bear directly on harness
design. Sources are listed at the end.

The short version: the runtime already has several mechanisms the commercial
harnesses either lack or only recently added. Section 2 catalogs what they do
that this system does not; section 3 lists the defects found; section 4 is the
plan, which fixes the defects first and then makes the two creators cheaper
per task without adding any layer to the system. Several gaps in section 2
are deliberately left alone, and section 4 says which and why.

---

## 1. Where Abjects is already ahead

Worth stating first, because the plan should protect these.

| Mechanism | Abjects | Elsewhere |
|---|---|---|
| Code-as-action over held payloads | `submit_job` runs sandboxed JS that messages objects; results never enter the model's context unless returned. Held payloads reachable from job code. | Anthropic shipped the same idea as "programmatic tool calling" in late 2025 and reports a 37% token reduction on complex research tasks. Claude Code and Codex do not expose it to their loops. |
| Payload handles | Oversized observations and results are held whole and addressed by `read_chunk` with grep, outline, or offset. Nothing discarded. | Claude Code truncates tool output at a byte cap and spills to a file. pi does the same. Neither offers grep over the held result. |
| Prediction ledger | Any action may carry `expect`; misses are surfaced beside the result and mined by TaskReviewer. | No equivalent in any of the five harnesses. |
| Baseline-relative gate | ExternalCreator captures pre-existing failures and blocks `done` only on the delta. Failure signatures strip line numbers so an insertion at the top of a file does not make old errors look new. | Claude Code, Codex, and OpenCode have no baseline notion; a repo with a pre-existing failing test either blocks or is ignored. |
| Assembled, not generated, handoff | ExternalCreator's session summary is built from facts the object holds (files, commands, exit codes). It cannot hallucinate a step. | pi and Claude Code compaction summaries are LLM prose. |
| Live capability discovery | The ask protocol and `poll_team` learn what an agent can do right now. Roster descriptions re-register as skills and MCP servers change. | Every other harness reads a static tool list at session start. |
| Memory with a feedback loop | TaskReviewer credits injected entries that helped (`markUseful`), mines prediction misses, grows a pattern language, and authors skills from repeated procedures. | Claude Code auto-memory and Codex `/memories` store facts; neither scores them or distills patterns. |
| Steering mid-run | Interjection queue, mid-round checks, `continue_scrum` / re-plan / `ask_user`, cancel-then-replan. | Claude Code queues messages; Codex and OpenCode interrupt. None re-plan a dependency graph around the new input. |
| Dependency graph with inferred edges | `consumes` implies an edge; critical-path priority; fairness across goals; cascade failure. | Codex multi-agent v2 and Claude Code workflows express fan-out, not data contracts. |
| Prompt cache discipline | Stable/volatile prompt split with an explicit breakpoint and per-agent cacheable-token logging. | pi does this well; Claude Code added cache metrics to `/cost` in 2.1.251. |

The runtime also has oscillation steering, progress-aware budget extensions, a
forced-final salvage call, batch actions with a terminal allowed as the tail,
per-agent concurrency, and paused-goal parking. All of that is table stakes in
2026 and it is present.

---

## 2. What the harnesses do that Abjects does not

Grouped by mechanism rather than by product. "Have" means present in the
runtime or one of the three agents; "partial" means present in one agent only
or present as prompt text rather than code.

### 2.1 Context economy

| Mechanism | Claude Code | Codex | OpenCode | pi | Abjects |
|---|---|---|---|---|---|
| Skills as progressive disclosure (name + description in prompt, body loaded on use) | yes | yes | n/a | yes | **no**: SkillAgent puts every enabled skill's full SKILL.md body in its prompt (a runtime-wide leak into every agent was found and removed during this review) |
| Deferred tool loading / tool search | yes (`ToolSearch`, `alwaysLoad`) | MCP tool pagination | no | additive tool loading | n/a for actions; relevant for skills and MCP tool lists |
| Structured, iteratively updated compaction summary | prose | prose | prose at 90% | **yes**: Goal / Constraints / Progress (Done, In Progress, Blocked) / Decisions / Next Steps / Critical Context plus read-files and modified-files | partial: ExternalCreator writes exactly this shape to the goal scratchpad; the runtime's `compress` distills the middle into prose |
| Do not prune tool results because pruning re-bills the cache | no | no | no | yes | no: the 32-message count cap drops the middle early and shifts the cached prefix |
| Reasoning effort per agent or task | effort levels | `ultra` to `low` per agent | per-agent model | per-session | tiers (fast / balanced / code / smart) per observe step; no effort dial |
| Output cap raised for long agent runs | 64k default, 128k ceiling | yes | yes | yes | provider per-tier sizing; no override knob |

### 2.2 Context isolation and delegation

| Mechanism | Claude Code | Codex | OpenCode | Grok Build | Abjects |
|---|---|---|---|---|---|
| Scoped sub-loop with its own context that returns a summary (explore, plan, verify) | `Task` tool, built-in Explore and Plan agents, fork | `explorer` and `worker` agents; subagents return summaries "to avoid context pollution" | `task` tool spawns isolated sessions | up to 8 subagents in worktrees | **no**: an agent that needs a 30-file investigation does it inside its own conversation. `submit_job` is mechanical only (no LLM). ScrumMaster fan-out exists at goal level but a running task cannot delegate. |
| Read-only planning mode | plan mode | `/plan` | Plan agent cannot `edit` | plan mode | partial: ObjectCreator has `kind: investigate`; ExternalCreator has no read-only mode |
| Session tree, fork, rewind | `/branch`, `/rewind` | `/fork` | git snapshots per step | tree sessions with summarized abandoned branches | partial: ExternalCreator stash checkpoints; AbjectStore 10-deep source ring; no conversation fork |

### 2.3 Verification

| Mechanism | Claude Code | Codex | OpenCode | Grok Build | Abjects |
|---|---|---|---|---|---|
| Diagnostics fed back after every edit | LSP in some surfaces | no | LSP diagnostics after file writes (their own docs recommend CLI typecheck instead) | no | yes via `checkCommand` on edit-set close (ExternalCreator), parse + call validation (ObjectCreator) |
| Independent verification pass | `/code-review` and `/ultrareview` verify each finding adversarially with a second agent; workflows have a Verify phase | `/review` | no | `/verify` builds, tests, boots, runs browser smoke checks in a sandbox | **prose only**: ScrumMaster prompt says "cross-check where correctness matters"; nothing enforces it; TaskReviewer runs after the goal and only for memory |
| Done gated on evidence | no | no | no | `/verify` is manual | partial: ExternalCreator gates `done` on the baseline delta; **ObjectCreator has no gate**, `opDone` records whatever the model claims |
| Feature list with `passes` flags that the agent may not edit | Anthropic's long-running harness paper | no | todo tools | no | GoalManager tasks are the equivalent at goal level; no per-task checklist |

### 2.4 Safety and control

| Mechanism | Claude Code | Codex | OpenCode | pi | Abjects |
|---|---|---|---|---|---|
| OS-level sandbox for shell | auto mode with injection probe and transcript classifier; Containment Escape rule | Seatbelt / Landlock / restricted tokens, independent of approval policy | no | no (extensions) | policy-level only: PermissionBroker, per-object command grants, path allowlists |
| Lifecycle hooks | 20+ events incl. PreToolUse, PostToolUse, PreCompact (can block), PermissionDenied, FileChanged | pre/post tool, turn boundaries, MCP-tool hooks | no | `tool_call`, `project_trust`, custom tools | none at the loop level; capability objects enforce; `agentActionResult` events exist for observers |
| Project trust gating instruction files and scripts | trust dialog | approval policy | no | yes | partial: ExternalCreator skips instruction files for untrusted projects, but `bash` still runs anything |
| Protected paths | hooks | sandbox | no | `protected-paths` extension | yes (ExternalCreator `ALWAYS_PROTECTED` + per-project) |

### 2.5 Operations

| Mechanism | Claude Code | Codex | Grok Bot | Abjects |
|---|---|---|---|---|
| Always-on agents with routines | scheduled cloud tasks, `/loop` | cloud tasks | bots with own cloud computer and routines | Scheduler, TriggerManager, per-workspace agents; comparable |
| Cost attribution incl. cache re-billing | `/cost` hit ratio and re-cached tokens | usage | n/a | LLM ledger per agent with cache read/write tokens; no re-bill attribution; no per-goal budget |
| Background shell with notification | `run_in_background`, Monitor | yes | yes | JobManager; ExternalCreator `bash` is synchronous with a 120s default |

### 2.6 Research results that bear on the plan

- **Programmatic tool calling and tool search** (Anthropic, advanced tool use): deferred loading cut tool-definition tokens 85% and raised Opus 4 accuracy from 49% to 74% on a tool-selection benchmark. Programmatic calling cut tokens 37%. Tool-use examples raised parameter accuracy from 72% to 90%. Abjects has the first and third partially; the skills injection is the gap.
- **Effective harnesses for long-running agents** (Anthropic): initializer agent, a feature list with `passes` booleans the agent may not edit, a progress file read at every session start, and browser-based end-to-end checks before marking anything passing. ExternalCreator's baseline plus session summary is the single-task version; the multi-session version is the GoalManager task list, which today has no "may not edit" discipline.
- **Beyond Compaction: Structured Context Eviction** (arXiv 2606.11213): typed, dependency-linked episodes evicted by a deterministic policy rather than summarized; 89 sequential tasks across 80M tokens with no accuracy loss. The payload-handle mechanism is a step in this direction; the missing piece is evicting completed action episodes whose effects already exist in the environment.

---

## 3. Review findings

Verified against the source on 2026-09-04. Ordered by severity within each
section. File references are to the current working tree.

### 3.1 Runtime (`src/objects/agent-abject.ts`)

**R1. Every task paid for every enabled skill's full body (FIXED 2026-09-04).**
`startTask` fetched `getEnabledSkills`, which returns the whole SKILL.md as
`instructions`, and appended all of them under "Available Skills" for every
agent's every task, in the volatile (uncached) block. SkillAgent, the only
agent that runs skills, already builds the same block into its own system
prompt, so it received the skills twice and every other agent (ScrumMaster
scrums, ObjectCreator builds, ExternalCreator tasks) received them for
nothing. With five skills of 3 to 8 KB each that was 20 to 40 KB per task.
The runtime injection was removed; skill exposure is SkillAgent's alone.
What remains for the plan is progressive disclosure inside SkillAgent.

**R2. Compaction is prose and the count cap fights the cache.**
`trimConversation` applies a 32-message count cap first, which drops the
middle of the conversation long before the 180k-char byte budget is reached
and shifts the cached prefix. The byte path then calls `compress`, whose
distill-middle stage produces an unstructured summary. pi's finding is that
pruning rarely pays once cache re-billing is counted, and that a structured,
iteratively updated summary (with read-files and modified-files carried
forward) loses far less than prose. ExternalCreator already writes that shape
to the scratchpad but the runtime does not use it for compaction.

**R3. No scoped sub-loop.** There is no runtime verb for "investigate X and
bring me back a summary" with its own conversation. `submit_job` covers
mechanical fan-out; it has no LLM. ObjectCreator investigating a 2000-line
target and ExternalCreator grepping a repo both do it in the parent's
context. Every harness reviewed here has this (Claude Code Task, Codex
explorer, OpenCode task, Grok subagents) and Codex's stated reason,
"context pollution", is exactly the failure mode in the Chat confabulation
audit memory.

**R4. No per-task plan ledger.** Agents narrate plans inside `reasoning`
where nothing tracks them. A small typed step list (pending, done, blocked)
rendered in the observation and carried across compaction is what Claude
Code's TodoWrite, OpenCode's todo tools, and Anthropic's feature-list JSON
all provide. TaskReviewer would also get a cleaner record than the transcript.

**R5. Budget is steps, not cost.** The LLM ledger attributes spend per agent
but nothing feeds it back: a goal can run 6 rounds at smart tier with no
cap, and `loopWarning` counts rounds, not dollars or tokens.

**R6. Action transport is fenced JSON with a repair-and-reparse loop.**
`parseAction` handles balanced-brace extraction, fence salvage, truncation
retries, up to 10 free reparses, and XML-tool-call hallucinations. Every
provider now offers a structured-output or JSON mode that would make the
envelope a guarantee rather than a negotiation. This is a decision for you
(section 5), because it touches the "actions are messages, not tool calls"
principle even though it changes only the wire format of the one envelope.

**R7. Tool-result eviction.** Payload handles hold bulk out of context, but
completed action episodes whose effects are already in the environment (a
file written and re-read, a deploy that succeeded) stay in the conversation
until compaction. The CWL result suggests a deterministic eviction of such
episodes beats summarizing them.

### 3.2 ExternalCreator (`src/objects/external-creator.ts`)

**E1. The gate can pass a failing run.** `judge` (line 526): when the
baseline was failing and the new run exits non-zero but `signaturesOf`
recognizes no failure lines (a runner whose output format the regex at line
465 does not match, or output that landed only in a summary line),
`newFailures` is empty and `passed` is true. A task can introduce a test
failure and be told "nothing new was introduced." The `unbaselined` and
green-baseline branches are hard-coded to fail, so the hole is specific to
the failing-baseline case, which is the common case on a real repo.

**E2. Every task with edits pays an extra `verify` step.** `afterMutation`
runs the check and records `lastCheck` but never resets
`mutationsSinceVerify`; only `opVerify` does. So even when the auto-check
passed and the project declares no separate `verifyCommand`, `gateVerdict`
refuses `done` until the agent spends a think on `verify`, which reruns the
same command. That is one wasted think and one redundant command run per
task on projects where check and verify coincide.

**E3. Baseline runs `verifyCommand` eagerly.** `captureBaseline` runs both
commands at task start with a 15-minute timeout each. The plan document
recommended check eagerly and verify lazily on first use. On this repo that
is the difference between a 3-second and a multi-minute task start.

**E4. Trust is enforced on instructions, not on execution.** An untrusted
project's AGENTS.md is correctly withheld, but `bash` runs whatever the model
asks, including the project's own lifecycle scripts. The prompt says "its
scripts should not be run"; nothing checks. Codex's point that the sandbox
and the approval policy are two independent dials applies here.

**E5. Concurrent tasks in one checkout are unaware of each other.**
Parallel tasks on one project are a feature: ScrumMaster stages parallel
rounds and `maxConcurrentTasks` is 3 so they actually run together. But each
task's bookkeeping assumes it is alone. `rollback` restores this task's
pre-image without checking whether another task has since edited the file,
so a parse-failure rollback in task A can erase task B's work. `judge`
attributes every new failure signature to the current task, so a failure B
introduced in a file A never touched blocks A's `done`. And nothing tells a
task that a sibling is editing the same file. The fix is coordination, not
a lock (plan item B3).

**E6. Instruction discovery is root-only.** `loadProjectInstructions` reads
AGENTS.override.md, AGENTS.md, CLAUDE.md at the project root. Claude Code
loads subdirectory files when a file under them is touched; pi walks
ancestor directories and dedups across worktrees. Monorepos lose their
per-package conventions.

**E7. No OS sandbox option for `bash`.** All enforcement is policy-level
(PermissionBroker, command grants, path allowlists). Codex ships Landlock and
Seatbelt; an opt-in `bwrap` or Landlock wrapper in ShellExecutor per project
would give the same two-dial model without changing any agent.

**E8. Edit matching is exact-only.** Correct and predictable, but OpenCode
reports fewer failed edits with a fallback ladder (whitespace-normalized,
indentation-flexible, block-anchor) that still returns a diff. Adopt only if
measured edit-failure rates justify it, as the plan document already says.

**E9. `bash` is synchronous.** A dev server or a watch build cannot be
started and observed; the 120s default kills it. Every harness reviewed has a
background shell with output polling.

What is right and should not change: the small prompt, the domain-neutral
kernel, checks that run themselves, `more: true`, the narrow parse-failure
rollback, stash checkpoints, and the assembled session summary.

### 3.3 ObjectCreator (`src/objects/object-creator.ts`)

**O1. No done gate.** `opDone` (line 2609) records `action.result` and
returns. "Deploy before done" (rule 9) and "verify behavior after deploying"
(rule 4) are the two most emphasized rules in the prompt and neither is
checked. The state needed is already in `turnLog`: whether a `deploy_*`
succeeded after the last staging edit, and whether any `call` to the target
(or a screenshot capture) happened after that deploy. ExternalCreator's
`finalize` pattern (downgrade the claim, carry the reason, notify) ports
directly.

**O2. The prompt carries corrective lore that belongs in the objects.**
About 240 lines. The world-teaching half is justified (the model has never
seen this system). The other half is accumulated incident lore: timeout
diagnosis, `inputTargetId`, the 3D depth-cue rule, `saveData` cadence, the
"do not make it conspicuous" passage. The project's own feedback memory says
UI guidance belongs in WidgetManager's ask guide, and the pattern language
exists for exactly this. Moving lore to the objects' `ask` answers and to
patterns keeps it live (it updates with the object) and shrinks the prompt
the model reads on every build.

**O3. Semantic review fails open.** Unparseable reviewer output is treated as
VERIFIED (lines 1777 to 1779). Acceptable because the review is advisory,
but it should be logged as "reviewer unavailable" in the deploy result so a
misconfigured review tier is visible.

**O4. Same-loop verification.** The loop that wrote the code exercises it.
Every rule about "state your draft sets is a claim, not evidence" is asking
the author to be its own auditor. See S4.

What is right: member-addressed edits, all-or-nothing sets, deploy as the
gate, hard-vs-advisory tiering, `clone_object` and `draft_via_llm` keeping
large source out of context, draft persistence across tasks, name-pinning of
verification calls to the spawned instance, tier selection per state.

### 3.4 ScrumMaster (`src/objects/scrum-master.ts`)

**S1. A refused dispatch stalls the goal for 30 minutes.**
`commitDispatchScrum` (line 1839): when `validateDataFlow` finds a problem,
it writes `scrum/dispatch-rejected` to the scratchpad, clears the staged
list, and returns. `dispatch_scrum` is terminal, so the OTA loop has already
ended; no task was committed, so no `goalReadyForCompletion` will fire; and
nothing listens for the rejected key. The comment says "the next scrum sees
this" but nothing schedules a next scrum. GoalObserver auto-fails the goal
after 30 minutes of no progress. Fix: enqueue a new scrum immediately with
the problems in its opening observation, or validate incrementally in
`actAddTask` so the model sees the problem before the terminal.

**S2. Partial `addTask` failure has the same shape.** Line 1895 logs
"partial commit may stall sprint" and continues; dependents of a task that
never got an id are silently mis-wired.

**S3. Verification is a suggestion.** The cross-check paragraph in the prompt
is good guidance and entirely optional. There is no policy that says "this
goal publishes externally / deletes things / reports figures, so a verify
round is required", and no roster role for a verifier. Claude Code's review
pipeline and the Workflow tool both make adversarial verification a phase,
not a hint.

**S4. Quick dispatch completes on an unchecked claim.** `completeOneShotGoal`
takes `tasks/<id>/result` verbatim. That is the right speed trade-off for a
lookup; for a task whose result text contains "should now", "I believe", or
no evidence markers, a deterministic prefilter (the same idea as Chat's
`mightBeUngroundedClaim`) could route to a review scrum instead.

**S5. Poll answers are not cached.** `poll_team` asks every eligible agent
(45s timeout each, parallel) and relies on the LLM choosing to
`save_knowledge`. Agent `ask` replies for the default question change only
when the agent re-registers; caching them keyed by
`(agentId, description hash)` removes most polls deterministically.

**S6. No cost in the snapshot.** `buildReviewSnapshot` has `loopWarning` at
4 rounds. The ledger knows what the goal has spent; a `spend` line (tokens,
USD, rounds) in the snapshot is free and lets the planner weigh a retry.

What is right: snapshot delivered in the opening observation (one think for
the fast path), balanced tier unless in trouble, contract-inferred edges,
critical-path priority, fairness, the interjection machinery, fast-tier
synthesis, the execution record for TaskReviewer, and the research-first
guidance.

---

## 4. Plan (implemented 2026-09-04)

### Principles this plan follows

- **Everything is an Abject and agents have no special standing.** No roles,
  no verifier hierarchy, no runtime delegation verb, no hook framework. Where
  the first draft of this plan proposed a new layer, this one uses a message
  to an object that already exists.
- **Delegation is a message.** An agent that wants a bounded investigation
  asks another agent the way it asks any object: `call("ObjectCreator",
  "modify", {...})` or `call("ExternalCreator", "runTask", {...})` and reads
  the reply. That works today. The plan only makes it known to the agents and
  keeps the replies compact.
- **Enforcement lives in the capability objects** (ShellExecutor,
  HostFileSystem, PermissionBroker), never in an agent's prompt.
- **Parallelism is the default, never serialized by a lock.** ScrumMaster
  stages parallel rounds and several ExternalCreator tasks may work in one
  project at once. Safety comes from each task checking before it acts and
  from siblings knowing about each other through messages.
- **One Abject per item.** Each item names the object that changes and how
  you know it worked.

### Step 1: bugs, in this order

| # | Where | Bug | Fix | Check |
|---|---|---|---|---|
| B1 | ScrumMaster | A `dispatch_scrum` refused for a data-flow problem, or an `addTask` that fails mid-commit, leaves the goal with no next scrum; GoalObserver auto-fails it after 30 minutes (S1, S2). | Run `validateDataFlow` incrementally inside `actAddTask` and return the problem as that action's error, so the model fixes it before the terminal. Keep the commit-time check as a backstop, and on any refusal or partial commit clear the round guard and `enqueueScrumTask` immediately with the problems in the task text. | Stage a task consuming a key nobody produces. The `add_task` fails with the key named; a forced commit-time refusal starts a new scrum within seconds. |
| B2 | ExternalCreator | `judge` passes a failing run when the baseline was also failing and the runner's output matched none of the failure-line regexes: `newFailures` is empty so `passed` is true (E1). | A non-zero exit with zero recognized signatures is `inconclusive`, never `passed`, and blocks `done` with a message naming the command. Add count extraction for tsc, vitest/jest, pytest, cargo, and go test, and compare counts as a second signal. | Failing baseline, then a task that adds a failing test in a runner with an unrecognized format: `done` is refused. |
| B3 | ExternalCreator, ExternalProjectRegistry | Several tasks may work in one checkout at once (this is wanted: ScrumMaster stages parallel rounds), but each task's rollback and verdict assume it is alone. Task A's parse-failure rollback restores its pre-image over task B's later edit, and a failure B introduced in a file A never touched blocks A's `done` (E5). | Make in-place parallel work safe without a lock. (a) Compare-and-restore: a rollback writes the pre-image only if the file still holds exactly what this task last wrote; otherwise it reports that a concurrent task changed the file and leaves it. (b) Per-file attribution in `judge`: new failures in files this task modified block `done`; new failures elsewhere are reported as "from concurrent work in this project, not yours" and stay advisory. (c) Sibling awareness through messages: ExternalCreator sends `taskStarted` / `filesTouched` / `taskFinished` events to ExternalProjectRegistry, which keeps the live set per project; a task's first observation lists sibling tasks and the files they have touched, and an edit to a file a sibling touched carries a one-line note. Soft guidance, no refusal. (d) Worktree mode stays per goal as today, so a goal's parallel tasks share one worktree and land on one branch. ScrumMaster's prompt gains one line: when staging parallel tasks on one external project, partition them by area so they do not edit the same files. | Two tasks edit different files in one project at once; both finish with `done`, neither's rollback touches the other's file, and a failure introduced by one is reported to the other as concurrent, not blocking. Two tasks edit the same file: the second's observation names the first. |
| B4 | ExternalCreator, ShellExecutor | The prompt promises an untrusted project's scripts are not run; `bash` runs anything (E4). | Add an `untrusted: true` field to ShellExecutor's exec request. When set, standing per-object grants are ignored and the command goes through the normal permission prompt naming the project. ExternalCreator sets it whenever `project.trusted` is false. Trusting the project restores grants. | An untrusted project's `pnpm install` prompts even though ExternalCreator holds a `pnpm` grant; after `setTrusted`, it does not. |
| B5 | ObjectCreator | `opDone` accepts any claim; the prompt's two most emphasized rules (deploy before done, exercise the behavior) are unenforced (O1). | Port ExternalCreator's finalize: on `done`, if the staged source is not deployed, or no `call` to the target and no screenshot appears in `turnLog` after the last deploy, downgrade to a failure carrying the reason and notify. State the gate in every observation once source is staged, so the refusal is never a surprise. | A loop that compiles and stops is reported "not deployed"; a loop that deploys and stops is reported "not exercised". |
| B6 | AgentAbject | Every agent's every task received the full body of every enabled skill (R1). | Done 2026-09-04: runtime injection removed; SkillAgent alone exposes skills. | Prompt-size log line per task no longer carries a `skill*` block. |

### Step 2: ExternalCreator efficiency

Each item removes a think, a command run, or uncached tokens from an ordinary
task. Nothing changes the action kernel or the gate's meaning.

| # | Change | Saves |
|---|---|---|
| X1 | When the auto-check after an edit set passes and the project has no separate `verifyCommand` (absent or equal to `checkCommand`), record it as the verification: reset `mutationsSinceVerify`, set `lastVerify`. The explicit `verify` step stays for projects with a heavier verify (E2). | One think and one redundant command run per task on typecheck-only projects, which is most of them. |
| X2 | Capture `checkCommand` at task start; capture `verifyCommand` on first `opVerify` and cache by HEAD in the goal scratchpad as now (E3). | Minutes off task start on projects whose verify is a full test suite. |
| X3 | Move the per-project block (name, root, commands, trusted flag, and the project's instruction files) from `taskPrompt` into the `systemPrompt` sent for that task. It is identical for every task in the same project, so it lands before the cache breakpoint. | The instruction files (up to 32 KB each) are read once per project per cache window instead of once per task. |
| X4 | HostFileSystem `edit`: when an `oldText` does not match, return the closest region (line-normalized similarity, a few lines of context) alongside the error. Benefits every caller of the capability. | The re-read step that follows most failed edits. |
| X5 | Load AGENTS.md / CLAUDE.md from a subdirectory the first time a file under it is read or edited, once per task, as a `<project_instructions path>` block (E6). Root files as today. | Wrong-convention edits in monorepos, which cost a whole round. |

### Step 3: ObjectCreator efficiency

| # | Change | Saves |
|---|---|---|
| Y1 | Make the semantic review non-blocking. `deploy_*` returns as soon as the object is live; `adviseSemantics` runs concurrently and its findings, if any, are placed in the next observation's CHECKS section. Skip it entirely when call validation is clean and the change touched fewer than N lines. | The reviewer's LLM latency on every deploy (often the longest single wait in a build). |
| Y2 | Expose `investigate` as a public method beside `create` and `modify`, returning a compact written report with a deferred reply. Note in both creators' prompts that the other creator is an ordinary object reachable with `call`: ObjectCreator for objects inside the system, ExternalCreator `runTask` for files on disk. Replies are already wrapped by `bulkAwareResult`, so a long report arrives as a handle. | Investigations that today run inside the caller's conversation; this is the "scoped sub-loop" as plain peer messaging, no new mechanism. |
| Y3 | Move incident lore out of the system prompt and into the objects it is about, delivered through their `ask` answers or seeded KnowledgeBase patterns: canvas input wiring and `inputTargetId` to WidgetManager, depth cues to the scene objects, `saveData` cadence to ScriptableAbject, timeout diagnosis to the runtime primer. The prompt keeps the world model, the action table, and the discipline (O2). | Prompt read on every think; rules stay current with the objects they describe, per the ask-protocol feedback. |
| Y4 | When the reviewer's output is unparseable, say "reviewer unavailable" in the deploy result instead of reporting VERIFIED (O3). | A misconfigured review tier is visible instead of silent. |

### Step 4: small shared changes

| # | Where | Change |
|---|---|---|
| Z1 | LLMObject `compress`, AgentAbject default | Drop the 32-message count cap so trimming is driven by the byte budget only, and make distill-middle produce the structured summary ExternalCreator already writes (Goal, Constraints, Progress with Done / In Progress / Blocked, Decisions, Next Steps, Critical Context, read-files, modified-files), updated from the previous summary rather than regenerated. |
| Z2 | ScrumMaster | Before `completeOneShotGoal`, run a claim prefilter on the result (the `mightBeUngroundedClaim` idea from Chat); on a hit, fall back to a review scrum (S4). Cache `poll_team` replies keyed by agent id and description hash, invalidated on `agentRegistered` (S5). |

### Not in this plan

Recorded so they are not re-proposed by accident. Each either adds a layer
the system does not need or is outside the two creators.

- A delegation runtime verb with roles (Explorer, Planner, Verifier): agents
  already message each other; Y2 covers it.
- A Verifier Abject and a verification policy in ScrumMaster: the done gates
  (B2, B5) put evidence where the claim is made, and the existing cross-check
  guidance assigns verification to a different agent when it matters.
- Per-task plan ledger, cost budgets, dependency-aware eviction, tree
  sessions: runtime features with no specific win for the two creators today.
- OS sandbox for ShellExecutor and lifecycle hooks: B4 gives trust its
  teeth without either.
- Structured-output transport for the action envelope: a provider-layer
  decision independent of this work.
- Progressive disclosure inside SkillAgent: SkillAgent's own scope.

## 5. Decisions for review

1. **B4's exec flag.** `untrusted: true` on the exec request, honored by
   ShellExecutor by ignoring standing grants. Alternative: ShellExecutor asks
   ExternalProjectRegistry whether the cwd is trusted, which keeps the caller
   honest but couples two objects. Recommendation: the flag; ExternalCreator
   is the only caller that knows a project's trust today.
2. **X3's per-project system prompt.** The cacheable prefix becomes per
   project rather than per agent. Tasks alternating between two projects
   alternate prefixes, which is still far cheaper than re-reading the
   instruction files every task. Recommendation: do it.
3. **Y1's skip threshold.** Skipping the semantic review on small clean
   changes trades a little advisory coverage for wall time. Recommendation:
   non-blocking always, skip below roughly 40 changed lines.

## Sources

Claude Code
- Features and settings reference 2026: https://hidekazu-konishi.com/entry/claude_code_features_settings_reference_2026.html
- Changelog with version numbers: https://claudefa.st/blog/guide/changelog
- Releases (2.1.247 to 2.1.261): https://github.com/anthropics/claude-code/releases
- March 2026 updates: https://www.builder.io/blog/claude-code-updates
- Subagents reference: https://thepromptshelf.dev/blog/claude-code-subagents-official-documentation-reference-2026/

Codex CLI
- Harness guide (sandbox, approvals, AGENTS.md, hooks, memory): https://blakecrosley.com/guides/codex
- Subagents and multi-agent configuration: https://learn.chatgpt.com/docs/agent-configuration/subagents
- Cheatsheet: https://shipyard.build/blog/codex-cli-cheat-sheet/

OpenCode
- Internals deep dive (tools, LSP, compaction, subagents, snapshots): https://cefboud.com/posts/coding-agents-internals-opencode-deepdive/
- LSP documentation: https://opencode.ai/docs/lsp/
- Overview: https://www.datacamp.com/blog/what-is-opencode

pi
- Coding agent README (tools, tree sessions, compaction, skills, trust): https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md
- Inside the pi harness (cache discipline, cost meter): https://rohitghumare.com/blog/inside-the-pi-harness/
- Extensions guide: https://www.aibuilderclub.com/blog/pi-agent-extensions-guide

Grok Build and Grok Bot
- Announcement: https://x.ai/news/grok-build-cli
- Developer guide (modes, subagents, /verify): https://www.developersdigest.tech/blog/grok-build-developer-guide-2026
- Grok Bot launch: https://www.unite.ai/xai-launches-grok-bot-always-on-ai-teammates-with-their-own-cloud-computers/

Research
- Anthropic, Effective harnesses for long-running agents: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Anthropic, Advanced tool use (tool search, programmatic tool calling, examples): https://www.anthropic.com/engineering/advanced-tool-use
- Beyond Compaction: Structured Context Eviction for Long-Horizon Agents: https://arxiv.org/abs/2606.11213
