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

- Conditional mutations serialize at the owning receiver. SharedState remains the existing replication system; local compare-and-set is not distributed consensus or a proof of stale-owner exclusion across partitions.
- Source activation restores prior source and internal data on tested lifecycle failures. Arbitrary external effects performed by lifecycle helpers cannot be rolled back as one transaction. Registry, object and persistence failures remain explicit reconciliation cases.
- Project snapshots hash the tree, excluding `.git`, and declare incomplete coverage. Large dependency trees are expensive; concurrent generation during verification can invalidate the result and require another check.
- Goal budgets reserve estimates before model calls and reconcile usage afterward. Provider billing can differ from estimates; this is not a hard billing guarantee. Unpriced models cannot satisfy a configured cost ceiling, and an interrupted request retains conservative accounting.
- Session usage is based on available LLM ledger records; goal resource receipts are the durable accounting source. A resumed task re-observes current resources and re-verifies authored changes.
- Automated learning tests use scripted decisions and observations. They prove that evidence reaches planning and subsequent retrieval, not that a particular model will generalize correctly. Published comparisons and repeated live dogfooding remain empirical work.
