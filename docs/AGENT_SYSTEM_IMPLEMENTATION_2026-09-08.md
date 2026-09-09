# Agent system implementation and testing

Implemented in the working tree on `main`, without commits. This accompanies the [six-phase plan](AGENT_SYSTEM_IMPROVEMENT_PLAN_2026-09-07.md). The plan records the original findings; line numbers in that historical review predate these changes.

## Architecture

State continues to belong to Abjects. Ask supplies discovery, constraints and collaborator agreements; ordinary messages perform operations. Receiver-side checks enforce revisions, operation identity, result semantics and permission scope. Pure codecs, graph functions and process adapters support the owning Abjects.

The central learning cycle is:

1. Scrum observes the goal, previous plans, predictions, actual outcomes, user steering and contextual patterns.
2. It asks collaborators for their interpretation and proposes a revision with assumptions, expected observations and reasons for change.
3. Agents execute under task identity, predict outcomes and retain full observations. A rejected candidate returns to the same conversation for correction.
4. Material discrepancies return to Scrum. Superseded work must stop or expose unresolved effects before replacement work proceeds.
5. Completion or failure preserves review evidence. TaskReviewer processes a durable backlog; KnowledgeBase records contextual pattern applications and counterexamples.
6. Later goals retrieve that evidence, reconsider applicability and record how it changes their decisions. This is explicit knowledge learning, not model-weight training.

## Changes across the six phases

| Phase | Implementation | Automated evidence |
|---|---|---|
| 1. Trustworthy outcomes | Runtime completion handshake, creator acceptance before settlement, schema validation, admission deduplication, task-scoped progress and callbacks, agreed domain-result contracts, terminal evidence before notification. Direct tasks cannot complete their parent goal. | Reliability and protocol tests cover rejected completion, invalid schemas, duplicate admission, first-touch instructions, verification commands, callback provenance and unrelated heartbeats. |
| 2. Reliable effects | Conditional file writes/rollback; complete project revision coverage with explicit incomplete snapshots; verification bound to command and revision; acknowledged source persistence; activation rollback; RunningProcess Abjects; scoped task grants. | Concurrent writer, project snapshot, lifecycle rollback, large process output, process cancellation and JavaScript compatibility tests. |
| 3. Adaptive Scrum and learning | Revisioned plans, supported/contradicted/unresolved predictions, observation-driven replanning and weaving, preserved unaffected tasks, contextual pattern evidence/history, durable retrospective backlog and parent goal resource accounting. | Learning-cycle, pattern and budget tests exercise a failed experiment, collaborator Ask, revised planning, retrospective creation, later retrieval, deduplication and concurrent reservations. |
| 4. Continuity and collaboration | TaskSession persists conversation, specialist state, hypotheses, operations, usage and result outbox. Resume/fork and explicit reconciliation; specialist restoration; stable Scrum operation IDs and commit receipts; dependency recovery; bounded same-agent delegation. | Session, recovery and delegation tests cover stale revisions, unknown effects, durable delivery retries, dependency reconstruction, child limits and cancellation during Ask. |
| 5. Creator quality | ObjectCreator binds behavior to its live object or owned widgets, UI captures to the correct application, and acceptance to matching live/durable source plus a persisted snapshot of exercised data. ExternalCreator retains project scope, instructions, full diagnostics and verification identity. Generic Ask/call supports unfamiliar project and verification services. | Deterministic creator gates and a scripted learning sequence run without a provider. Real application quality, visual judgment and held-out model generalization require live trials. |
| 6. Evaluation and adoption | AgentEvaluation owns the 40-case acceptance catalog, Ask-negotiated driver/verifier protocol, three memory conditions, configuration matching, durable reports and metrics. AgentBrowser exposes Sessions with inspection, pause/resume/fork and reported usage. | Harness tests count false success and setup/cleanup errors, reject unmatched comparisons and restore interrupted reports without replaying unknown effects. |

The tests establish particular invariants. They do not establish that the creators outperform another product or that learned patterns improve held-out tasks. The 40 evaluation cases are an acceptance catalog, not 40 completed live model runs. Live evaluation requires fixture driver and verifier collaborators; this change does not bundle a fully populated set of browser/repository fixtures for that catalog.

## Run checks

After restoring in-process JavaScript execution, fixing goal startup and workspace usage accounting, removing temperature overrides, preserving synchronous script handlers and repairing Chat goal progress forwarding, validation recorded 149 tests passing with zero failures or skips, plus passing TypeScript checking and the server build. The separate-process isolation tests were replaced with compatibility checks for direct helper references, source factories, computed handlers and VM timeouts. The client build had passed before these server-side changes. These include the existing repository tests as well as the added agent tests.

The goal startup regression confused Scrum's internal queue ticket with a dispatched TupleSpace task, causing admission to reject initial planning before the first model call. Queue records now own the optional dispatch association, including for legacy specialist handlers. The runtime observes `executeTask` replies and preserves startup failures through normal result delivery; Scrum registers attempt metadata before enqueueing so fast failures enter its bounded retry path. New message-bus tests cover real goal creation through Scrum, JobManager and a scripted model to completion; durable startup failure and Scrum retry scheduling; legacy tuple admission; and queue recovery after thrown or returned setup errors.

A subsequent packaged-app test exposed a second failure: the global LLM service searched its own registry for a workspace GoalManager and blocked every goal-associated model request. Accounting now resolves the message sender’s workspace through WorkspaceManager and discovers GoalManager in that workspace registry. The goal regression uses real global/workspace registries and LLMObject with a scripted provider; concurrent-workspace checks verify separate receipts, budget enforcement and rejection before provider execution when the owning service or goal is unavailable. Scrum’s final error no longer assumes every planning failure is a provider configuration problem.

Temperature overrides were removed after WebAgent’s request to `claude-opus-5` failed with Anthropic’s “temperature is deprecated for this model” response. Agent planning and all provider adapters now use model sampling defaults. The shared option and provider-specific temperature exceptions were removed; old JavaScript options containing the field are ignored. Regression coverage checks actual completion and streaming request bodies against the reported rejection, without contacting a live provider.

The Pong background log exposed a missing progress bridge: Chat began waiting for goal `dbf211c4` at T+175093ms, but its runtime's `submitJob` request expired at T+475087ms while ObjectCreator continued working. GoalManager updates refreshed Chat's local wait without refreshing that outer request. Chat now retains the waiting callback's sender and task ID and forwards observed progress from that goal or tracked descendants as task-scoped messages through JobManager to AgentAbject. Unrelated goals no longer reset the local goal wait. There is no new polling or timeout increase. Four message-bus regression tests exercise the real Chat and JobManager handlers: root and descendant progress over multiple outer timeout periods, completion and failure delivery, independent requests sharing JobManager, untrusted/unrelated updates, and a goal whose progress stops.

From the repository root:

```bash
pnpm typecheck
pnpm test
pnpm test:agents
pnpm bind
pnpm etch
```

`pnpm test` includes the agent suite, so the separate agent command is useful when iterating on this subsystem. Shell process tests execute real child processes. In a restricted development sandbox, use an execution environment that actually permits the child processes; an empty log with exit code zero is not test evidence.

Generated JavaScript has been restored to the previous in-process Node.js `vm` implementation at the user's request. JobManager, ScriptableAbject, HTTP handlers and trigger expressions use that implementation again. The separate JavaScript execution Abject, subprocess adapter and platform requirements were removed. Source factories, computed handler names, direct helper calls and shared object references work as before. Shell command lifecycle management remains separate from JavaScript execution.

## Follow-up fixes from the commit/push failure

The new log showed ExternalCreator failing during its initial repository snapshot on
`release/linux-unpacked/resources/app.asar`, followed by Scrum repeatedly rejecting
replacement work with `Task runtime unavailable`. HostFileSystem now uses Electron's
`original-fs` for physical host access, without changing process-wide archive handling.
ExternalCreator still requests revisions through ExternalProjectRegistry messages;
HostFileSystem owns filesystem access and its permission gate. GoalManager now retries
discovery of AgentAbject when it needs the runtime, covering the normal startup order
where GoalManager is created first.

The code review also found and fixed three continuity bugs: result delivery now prefers
the original recipient ID and never substitutes another Chat by name; creator restore
handlers consume the runtime's decoded snapshot without decoding Maps/Sets twice; and
paused, resumed, clarification-paused and stopped goals persist their lifecycle state.
Checkpoint timestamps prevent older learning snapshots (including legacy snapshots
without timestamps) from overriding newer SharedState metadata. New task sessions
retain agent IDs so resumption can preserve instance identity as well.

Validation: the full suite passed 160 tests with no skips, and TypeScript checking and
the server build passed. Eleven added regression tests cover these failures, including
the ExternalCreator → ExternalProjectRegistry → HostFileSystem message path, denied
paths, read-only access, session ownership and symlink handling. The filesystem test
also passed when bundled and executed by the packaged Electron binary with
`ELECTRON_RUN_AS_NODE=1`; a Node-only test would miss Electron's archive interception.
All changes remain uncommitted.

## Suggested live testing

Use a test workspace and a disposable repository checkout for deliberate interruption and conflict cases.

1. **Create and evolve an application.** Ask ObjectCreator for a counter with increment, decrement and reset. Exercise its widgets, inspect its screenshot, increment several times, then request a modification. Verify that data survives the update and workspace restart. Ask the saved app about its API and use it in a second goal.
2. **Reject and repair a candidate.** Request a change that initially fails a behavior check. Confirm that the same task continues, its dependents stay blocked and the final result refers to the corrected revision. Capture an unrelated window and verify that it does not satisfy target visual evidence.
3. **Repository verification.** Configure different fast and full commands. Introduce an exported API change affecting an untouched consumer. A fast pass must not satisfy full verification. Run a generator after verification and confirm that the changed revision requires another check.
4. **Conflicting edits.** Change a file outside the agent after its edit, then request rollback. The other writer's content must survive and the conflict must be reported.
5. **Interrupt and resume.** Pause a task in AgentBrowser → Sessions. Inspect retained dialogue and outcomes, then resume or fork. For a worker interruption during an effect, inspect the receiver first and reconcile with evidence; the Resume control must not silently retry an unknown command.
6. **Scrum adapts and learns.** Introduce a constraint invalidating an earlier assumption. Inspect GoalManager's `learning/plans` and observations: the next Scrum should explain the discrepancy, ask an affected collaborator and change the experiment or plan. Fail or finish the goal, inspect the retrospective, then run a related goal and an unrelated goal to assess whether retrieval is appropriately scoped.
7. **Budgets and children.** Configure a goal budget, delegate bounded work and inspect shared resource receipts. Cancel the parent while a collaborator is still negotiating. No late child should start, and unrelated tasks should continue.

## Inspect and recover through messages

Ask each receiver for its current interface before using these messages. The examples use the ordinary JobManager/generated-object `call` and `dep` helpers.

```js
const runtime = await dep('AgentAbject');
const sessions = await call(runtime, 'getSessions', {});
const session = sessions.find(s => s.id === desiredSessionId);

// Inspect the full checkpoint, including dialogue and unresolved operations.
const record = await call(await dep('TaskSession'), 'get', { id: session.id });

// Resume uses a revision check. The runtime restores specialist state and
// sends terminal results back to the specialist that owns completion logic.
await call(runtime, 'resumeTask', {
  id: session.id, expectedRevision: session.revision
});
```

If an operation's effect is unknown, inspect the actual filesystem, process, object, tuple or other receiver. Record its evidence through `reconcileTask` with `id`, `expectedRevision`, `evidence` and `outcome`, refresh the session revision, then resume. Reconciliation records a judgment; it does not undo effects or independently prove an arbitrary assertion. Forking preserves uncertainty and does not restore a filesystem snapshot.

GoalManager exposes `getGoal`, `pendingReviews`, `getBudget`, `configureBudget`, `recordObservation`, `recordPlan` and task settlement messages. Plan records live at `scratchpad['learning/plans']`; observations and task evidence have stable keys in the same durable learning record. KnowledgeBase exposes `weave`, `patternHistory` and `recordPatternApplication`.

## Evaluation protocol

Use distinct driver and verifier Abjects. The driver owns fixture lifecycle; the verifier independently inspects effects against acceptance criteria. AgentEvaluation supplies intent to execution and criteria to verification in separate messages.

The driver answers Ask and implements:

| Message | Contract |
|---|---|
| `evaluationProtocol` | Return `{version:1, supportsConditions:['fresh','frozen','learning']}` only for supported conditions. |
| `prepareEvaluation` | Receives `trialId`, `caseId`, `condition`, `seed`. Return a fixture reference plus `configurationFingerprint`, `baselineMemoryFingerprint`, `condition`, `isolated:true`. Fix model, capabilities and budgets. Keep hidden criteria outside evaluated memory. |
| `executeEvaluation` | Receives fixture, trial, case and intent. Return the agent's `success` claim, artifact references, actual tokens/cost, interventions, Ask calls, decision trace and pattern revisions when available. Include retrospective cost. |
| `cleanupEvaluation` | Always called, including failed setup. Release fixture resources; retain evidence and the appropriate memory state for the condition. |

The verifier answers Ask and implements `verifyEvaluation({trialId,caseId,fixture,acceptance,artifactRefs})`, returning `accepted`, independent `evidence`, and optional `duplicateEffects`/`recovered`. It must not simply repeat the author’s success claim.

Fresh resets memory for every episode; frozen keeps the initial library unchanged; learning retains experience within that trial's sequence. Trials must not share mutable learning state. Fingerprint matching rejects declared configuration drift, while the collaborators remain responsible for enforcing actual isolation.

```js
const evaluator = await dep('AgentEvaluation');
const { id } = await call(evaluator, 'run', {
  driverId, verifierId,
  options: {
    conditions: ['fresh', 'frozen', 'learning'],
    repetitions: 3, seed: 17
  }
});
const report = await call(evaluator, 'get', { id });
```

Reports include acceptance, false success, failures by task family, p50/p95 elapsed time, token/cost totals, cost/tokens per accepted task, interventions, Ask counts, recovery and duplicate effects. Missing measurements remain explicit; unknown cost cannot produce a meaningful cost-per-accepted figure. Wilson intervals are descriptive and do not remove correlation between repeated or related episodes. `list` and `get` recover saved reports; interrupted live trials are retained without automatic effect replay.

## Final review fixes

- Standing rule edits are proposals to PermissionBroker. The receiver asks GlobalSettings for explicit approval through the existing message protocol and prompt queue, including when callers bypass ExternalProjectBrowser. Rejected, unavailable, or failed dialogs leave policy untouched; edits reject stale indices after waiting for approval. The browser delegates final confirmation to the broker.
- GoalManager persists retained task IDs as part of each round's backlog. Their original round remains available for attribution, while their completion gates the new round's review. Replaying or restoring the round retains the same membership.
- The bundled KnowledgeBase C++/WASM receiver now implements application evidence, revision history, conditional updates, feedback deduplication, structured pattern presentation, and contextual retrieval. Storage and SharedState remain message-based dependencies. The rebuilt `main.wasm` and extracted manifest are version 3.4.0. TaskReviewer asks the actual receiver to describe its protocol before relying on learning mutations.
- RunningProcess tracks truncation separately for each stream. ShellExecutor preserves the original byte count and earlier truncation when bounding the final reply; complete output remains accessible through the process Abject's `readOutput` messages.

`src/objects/agent-system.review-fixes.test.ts` covers direct-bus authorization, concurrent approvals, retained work across replay/restart, both KnowledgeBase implementations (including native persistence/reload and stale revisions), protocol rejection, and actual subprocess output retrieval. Validation includes the full test suite, `pnpm typecheck`, `pnpm bind`, and `pnpm smelt`. The desktop package itself has not been rebuilt.

## Practical limits

### Completion and cancellation after the commit/push retry

The live commit/push run finished its repository work but kept invoking the model because snapshots included the application's own changing logs and runtime state. Successful commands were reported as failures when these snapshots changed. The following corrections are in the working tree:

- Project revision snapshots now respect the existing ignore rules, with explicit edited paths retained even when ignored. The HostFileSystem Abject returns exclusions and coverage issues through ExternalProjectRegistry. A read-only check of this repository covered 419 files in 72 ms and excluded the live log, runtime databases, dependencies, and build output.
- Check exit status and snapshot confidence are separate. Successful checks can finish with a receiver-authored coverage limitation in their report. Known subsequent input changes and actual failed checks still require attention. Exact declared commands count whether invoked through `verify` or `bash`; unchanged input snapshots preserve evidence across read-only commands and commits.
- Completion permits one correction attempt before preserving the candidate as an unresolved partial outcome. It does not spend the rest of the task budget repeating the gate.
- Cancellation is checked after awaited observation/thinking and before dispatch, including runtime verbs and completion validation. A late model response cannot start a new job or publish success. User-stopped goals retain evidence without automatically starting a learning review.
- Stale Scrum results for completed, failed, or removed goals are acknowledged without executing their terminal action. Transient outbox delivery failures back off rather than replaying every three seconds.
- ExternalCreator no longer repeats the preceding tool result in each observation. Its instructions use receiver `describe` messages for exact schemas and reserve Ask for interpretation and agreement.

Regression coverage is in `src/objects/agent-system.verification.test.ts`; the full suite has 176 passing tests. Typecheck and server build pass. These tests use fixed decisions and real bus paths without paid model calls; they do not establish a model's live judgment quality.

### Scope of guarantees

- Conditional mutations serialize at the owning receiver. SharedState remains the existing replication system; local compare-and-set is not distributed consensus or a proof of stale-owner exclusion across partitions.
- Source activation restores prior source and internal data on tested lifecycle failures. Arbitrary external effects performed by lifecycle helpers cannot be rolled back as one transaction. Registry, object and persistence failures remain explicit reconciliation cases.
- Project snapshots cover inputs selected by ignore rules plus explicit edited paths. They report exclusions and incomplete coverage. A passing check is evidence of that command's outcome; incomplete coverage or generation during the run is reported as a limitation, not relabeled as a test failure.
- Goal budgets reserve estimates before model calls and reconcile usage afterward. Provider billing can differ from estimates; this is not a hard billing guarantee. Unpriced models cannot satisfy a configured cost ceiling, and an interrupted request retains conservative accounting.
- Session usage is based on available LLM ledger records; goal resource receipts are the durable accounting source. A resumed task re-observes current resources and re-verifies authored changes.
- Automated learning tests use scripted decisions and observations. They prove that evidence reaches planning and subsequent retrieval, not that a particular model will generalize correctly. Published comparisons and repeated live dogfooding remain empirical work.

## Evidence reuse and the world-model learning loop

The September 8 review/commit run completed, but repeated verification and small output reads inflated its model-call count. The follow-up keeps baseline comparison, output retention, goal-level learning, and context compression while connecting the evidence they already hold.

- ExternalCreator exposes pending/completed baselines and returns structured verification evidence. Stable passing evidence can be reused within the same task for the same declared command and scoped revision; a newer failed result supersedes older passes. Concurrent requests for the same task/command share execution. `force: true` requests a fresh verification. Reuse does not establish that ignored dependencies, environment, toolchains, services, or Git-derived inputs stayed unchanged; force a fresh run when those inputs matter or have changed. No evidence is shared across tasks. Cancellation prevents a waiting verification from launching another command.
- Command results preserve exit status, output truncation metadata, and the existing RunningProcess output reference. `read_output` routes through ExternalCreator to the process owner and rejects handles outside the task. Process output expires after an hour or restart; a retained preview does not imply complete upstream coverage. Named verification avoids inferring individual command status from arbitrary shell pipelines. Recognized Node test totals are advisory; exit status remains authoritative.
- Payload counters survive session restoration, including legacy snapshots without counters. Git diffs expose section offsets and paging examples use the supported 30,000-character range. Prediction observations no longer evict command payloads from the five-entry cache.
- GoalManager provides a task briefing with bounded scratchpad values and references to omitted data. Complete task inputs and learning evidence remain available through messages. AgentAbject logs each prompt block's size so future runs can identify actual context costs without logging the block's contents. Compression remains the continuity fallback.
- Domain actions and submitted jobs preserve the pre-action prediction, declared applied pattern IDs/revisions/reasons, and subsequent feedback separately. Missing predictions and interrupted actions remain unknown. An operation-status match is explicitly distinguished from semantic support for a prediction. Reviewer assessments are recorded through GoalManager, separately from original observations, with replay-safe identity and provenance.
- TaskReviewer still reviews completed and failed goals. Its complete opening dossier, including prefetched knowledge and prediction indexes, is bounded to 40,000 characters. Contradictions are prioritized across all retained task records; full transcripts, individual observations, plans, and assessments remain accessible through `read_evidence`. Distinct pattern applications within a goal have separate episode identities while legacy goal-level applications retain their prior deduplication identity. The KnowledgeBase's existing revision/evidence protocol owns pattern updates and candidate-pattern learning.

Regression coverage exercises resumed output identity, stable and failed verification reuse, explicit reruns, output ownership, cancellation, prediction timing, missing observations, bounded briefings with retrievable evidence, semantic assessments, and distinct helpful/harmful pattern applications. These checks use fixtures and bus messages without paid model calls; actual model-call savings must be measured on a subsequent live run.


## Automatic pattern provenance and review settlement (September 9)

KnowledgeBase now presents an opaque `patternRef` with each readable pattern. Legacy prose and structured entries without learning metadata start at revision 1; subsequent edits advance revisions inside the receiver. Agent prompts declare only `{id, why}`. AgentAbject retains the receipts from injected patterns and full-entry recall in its checkpoint, and sends `beginPatternApplication` before execution. That message binds the selected version to a stable task/step application identity. Model-supplied revisions and application references are discarded.

TaskReviewer identifies an observed task and step and sends `assessPatternApplication` with the captured application reference, verdict, and evidence. Feedback preserves the original version and declaration even after the current pattern changes or its bounded revision history is pruned. Identical retries are acknowledged; conflicting evidence is reported. Legacy episodes with an explicit recorded revision remain usable through the compatibility API. Missing historical provenance stays unresolved; the reviewer never substitutes the current revision.

Reviewer completion summarizes acknowledged learning updates and recorded semantic assessments. Rejected and unresolved updates retain their action, evidence, and error in `learning/reviewOutcome`. Missing assessments remain unresolved even if every operation succeeded. Partial completion is accepted and retained by GoalManager without an automatic retry loop. Review checkpoints include these outcomes. Failed reviews also settle as partial, preserving the goal's original execution evidence for subsequent investigation. Learning still includes useful patterns, counterexamples, and candidate discoveries on successful and failed goals.

ExternalCreator exposes byte offsets and continuation actions beside retained-output payloads, uses 30,000-byte pages, and directs truncated-preview recovery through the existing RunningProcess. Re-selecting the active project returns a compact confirmation. Host access continues through capability messages; no direct filesystem or shell path was added.

The regression suite covers both TypeScript and compiled WASM KnowledgeBase implementations, legacy normalization, selection followed by concurrent revision changes, history pruning, replay and conflicts, successful operations with contradicted predictions, checkpointed partial review outcomes, and complete output paging without command re-execution. Model-call savings still require measurement in the next live Abject run.
