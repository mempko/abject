# Connected world-model learning

The implementation links episode evidence, assessments, proposed changes and knowledge-owner receipts. Task completion remains independent of unfinished learning. Changes are uncommitted; the running application has not been restarted or deployed by this implementation session.

## Message ownership

- **AgentAbject** captures factual `knowledgeRef` receipts alongside the actual shown text, retains pattern application provenance, and forwards explicit reviewer selections to TaskReviewer. It exposes original historical review proposals through TaskSession messages. No direct database reads are added to reviewers or agents.
- **GoalManager** persists learning decisions and evidence snapshots, owns assessment history, and retains unfinished work independently of review acknowledgment. Its journal can restore unfinished learning even when the old goal index or SharedState metadata is gone.
- **TaskReviewer** interprets the evidence and selects a disposition. Individual actions and completion bundles enter the same decision journal. It consumes pending effects and performs bounded delivery recovery or one focused semantic repair.
- **KnowledgeBase**, in TypeScript and native/WASM, validates the proposed effect against the owner journal and selected version, saves the changed entry and receipt, then acknowledges it. Knowledge storage and synchronization remain inside KnowledgeBase.

The shared contract is `src/core/learning.ts`. New owner messages include `recordLearningDecision`, `getLearningDecision`, `getLearningEffect`, `changeLearningEffect`, `pendingLearningDecisions`, `claimLearningRepair`, `resumeLearningDecision`, `getLearningStatus`, and KnowledgeBase's `applyLearningDecision`.

## Evidence, revisions and retrieval

A completion can include `evidence`, `evidenceRefs`, and `knowledgeUpdates`. Explicit shared evidence is inherited by the contained effects; it need not be repeated on every archive. References point to owner-recorded task, observation or assessment keys. Missing explicit references are rejected even when other referenced evidence exists.

Original proposals survive validation failures. Each effect retains its target, immutable delivery identity, state, attempts, error, history and receipt. Factual version references are opaque; the model does not assign revision numbers. Legacy selections without captured references remain unknown.

Supported dispositions are create, revise, confirm, narrow scope, supersede, dispute, pattern application feedback, and no change. Pattern creation/revision uses the existing structured-pattern representation. Applied pattern feedback retains the version actually used and does not award usefulness merely for injection or application.

The knowledge owner assigns learning revisions and stores prior content, rationale, evidence and receipts. Duplicate delivery returns the original receipt. Concurrent edits conflict. Retirement waits for acknowledged replacement effects. User-authored entries cannot be automatically overwritten or archived; accepted disputes remain visible.

`recall`, `match` and `weave` accept an explicit `scope`. Agent task configuration can provide `knowledgeScope`; runtime retrieval forwards it. A scoped supersession hides the old claim in that scope. With unknown scope, the claim remains visible with a supersession notice instead of silently hiding information that might apply elsewhere. Global archival hides an obsolete entry everywhere. Scope is never inferred from overlapping query words.

Legacy flat knowledge APIs remain compatible. Their timestamps participate in opaque selection references, so an intervening ordinary edit conflicts with an older learning proposal. Learning history is retained during cleanup and protected against stale peer writes, including legacy whole-array synchronization.

Identical prediction assessments return the existing receipt. Conflicting submissions require an explicit revision with evidence references. Earlier assessments remain in history. If an accepted knowledge change cited the revised assessment, GoalManager queues focused reconsideration; it does not silently undo the knowledge change.

## Recovery and limits

Delivery retries keep the same operation ID, use backoff, and stop after three attempts. Missing semantic content and version conflicts can receive one focused repair task, capped at three steps and 90 seconds and charged to the original goal budget. Failed, interrupted or inconclusive repairs remain inspectable; a new retrospective or original task is not launched to fix them.

A semantic repair cannot replace an operation with an unknown delivery outcome. Such an operation must first reconcile using its original identity. Within an active review, `repair_learning` addresses an existing decision/effect explicitly. Further automatic repair requires a new decision from changed evidence; explicit `resumeLearningDecision` is available to the reviewer or original goal creator.

Stopping a goal also cancels review tasks charged to that goal and pauses unfinished learning. Receiver acknowledgments arriving for already completed writes can still be recorded. Unfinished work stays paused until explicitly resumed.

On updated application startup, AgentAbject can recover original proposals from retained legacy TaskReviewer sessions. TaskReviewer journals partial reviews once, preserving the original response and available evidence. A focused repair compares those proposals with current knowledge. It must not assume that an archive lacking evidence was already applied or repeat an update that is already correct.

This recovery path covers the two previously dropped stale-entry archives. **The live workspace entries were not edited during implementation.** Their actual recovery must be checked after the updated application runs; no historical evidence is fabricated and no database repair bypasses the owners.

## Validation and semantic evaluation

`agent-system.world-model.test.ts` exercises the owner protocol over the bus, including TypeScript/WASM parity, shared evidence, malformed effects, late assessment revisions, dependency ordering, lost acknowledgments, restart recovery, goal-index loss, protected disputes, cancellation, stale peer synchronization, bounded repair, original-session proposal recovery, and subsequent normal AgentAbject retrieval.

The existing regression suite also covers operation-status versus semantic assessments, complete retained output, pattern version capture, and cancellation during capability calls.

`tests/fixtures/learning-judgment.json` is a ten-case labeled corpus for semantic judgment. It covers stale claims, retained previews, expected rejection, transient failures, absent predictions, unrelated scopes, protected claims, unjustified usefulness and pattern counterexamples. To evaluate actual reviewer outputs, supply one answer per case:

```json
[{"id":"stale-tests","verdict":"contradicted","disposition":"revise","scope":"project:A@r7","llmCalls":1,"tokens":1000}]
```

```sh
node --import tsx scripts/evaluate-learning.ts review-answers.json
```

The evaluator scores assessments, dispositions, scope and pattern usefulness, and reports supplied calls/tokens. Passing the evaluator's own regression is not evidence of model intelligence. An actual model run and review of its explanations are still required.

For a live acceptance run, inspect `GoalManager.getLearningStatus`, the decision/effect receipts, subsequent retrieval, and `abject.log`. Compare correction accuracy, stale retrieval, false corrections, unresolved age, review/repair cost and repeated avoidable work. A saved correction by itself does not establish improved reasoning.

Validation completed in this working tree:

- `pnpm test`: **218/218 passed**, including 20 new world-model regressions.
- `pnpm typecheck`: passed.
- `pnpm bind`: passed.
- `pnpm smelt`: passed; the shipped native module and manifest describe KnowledgeBase 3.6.0.
- `git diff --check`: passed.

No live model-quality score is reported, and no live stale-entry repair is claimed from these deterministic tests.
