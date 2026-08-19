# Making a scrum round a better DAG

Status: **implemented**. See §11 for what landed and where it diverged.

The question this answers: the scrum planner can already express an arbitrary
dependency graph, so what is worth adding to make that graph reliable, well
scheduled, and legible, now that agents genuinely run tasks in parallel.

---

## 1. What exists today

The dependency machinery is already in place and is not the problem.

| Piece | Where | Behavior |
|---|---|---|
| Edge declaration | `scrum-master.ts:1227` | `add_task({ dependsOn: [0, 2] })`, indices into the current scrum's staged batch |
| Default when omitted | `scrum-master.ts:1233` | Sequential on the previously staged task |
| Commit | `scrum-master.ts:1749` | Indices resolve to task ids, blocked tasks register in `pendingDeps` before any enqueue, dependency-free tasks enqueue |
| Release | `scrum-master.ts:1808` | Every waiting task loses the completed id from its blocker set; those reaching zero enqueue |
| Failure | `scrum-master.ts:1852` | Descendants cascade-fail, recursively |
| Retry | `goal-manager.ts:1350` | `attempts` / `maxAttempts: 3` with a `failureHistory` |

Fan-in, fan-out, diamonds, map-reduce and mixed-depth joins all work. That was
verified against a faithful model of the `pendingDeps` machinery rather than by
reading alone.

### The one structural constraint, and why it stays

A round is one scrum, tracked as `goal.currentScrumNumber`. GoalManager only
wakes ScrumMaster for the next scrum once every task at that number is
terminal (`goal-manager.ts:800`):

```ts
else return; // at least one current-scrum task is still pending / in-flight — not ready
```

So edges exist inside a round, and between rounds there is a total barrier.
That barrier is deliberate: the scrum IS the re-plan checkpoint, and a
mechanism that let a graph grow around it would be working against the point of
having one. **This plan does not touch it.** The earlier idea of per-task
"expansion points" that fire a scoped scrum on one task's completion is
dropped.

### FINAL nodes are dropped too

DAGMan needs a FINAL node because nothing plans after a failed graph. Here the
review scrum already fires on failure: `permanently_failed` counts as terminal
in the readiness loop above, so an all-failed round still wakes ScrumMaster
with `failedTaskIds` populated and it can plan cleanup or a report in the next
round. A FINAL node would be a second mechanism for a job the scrum already
does.

### What that leaves

If the barrier is a feature and rounds are the unit, then the work is making a
**single round** correct, well scheduled, and visible. The five changes below
are in that frame. Two are correctness, two are scheduling, one is visibility.

---

## 2. Named nodes

**Problem.** Edges are positional indices into the staged batch. For a planner
staging eight tasks that is genuinely hard to get right, and the failure mode is
silent: an off-by-one produces a valid graph with the wrong shape, and nothing
downstream can tell it was not intended. It is also why a planner reaches for
narrow rounds, which is the opposite of what we now want.

**Proposal.** Accept an optional planner-chosen `id` on `add_task`, and accept
names in `dependsOn` alongside indices:

```
add_task({ id: "audit-web", description: "...", assignedAgentName: "..." })
add_task({ id: "fix-web", dependsOn: ["audit-web"], ... })
```

Resolution happens at stage time, exactly where indices are validated now, so
an unknown name is refused immediately with the list of known ids. Indices keep
working; a batch may mix both.

**Cost.** Small. A name-to-index map on the in-flight scrum, one branch in the
`dependsOn` validation at `scrum-master.ts:1227`, and prompt guidance.

**Risk.** Low. Duplicate ids need refusing at stage time, and an id that
collides with a numeric index string wants a rule (treat a value as a name only
when it is a non-numeric string).

---

## 3. Edges derived from `produces` / `consumes`

**Problem.** `consumes` is advisory. It is stored (`scrum-master.ts:1246`), used
to inject scratchpad context, and used to word the cascade-fail message
(`scrum-master.ts:1848`), but it creates no edge. The prompt tells the planner
to pair it with `dependsOn` by hand.

So "declared `consumes`, forgot `dependsOn`" is a live failure mode, and its
symptom is the bad kind: the consumer runs before its producer, reads a key
that is not there yet, and either fails confusingly or invents a value and
carries on.

**Proposal.** If task B consumes key K and task A in the same round produces K,
that is an edge. Add it. Derived edges union with declared ones, so a planner
that declares both gets the same graph, and a planner that declares only the
data contract gets a correct graph anyway.

**Why this one first.** It converts a whole class of planning error into
something structurally impossible, and it rewards exactly the behavior we want
from a planner: describing what a task needs rather than hand-maintaining a
topology.

**Cost.** Small, and it lands in `dispatch_scrum` where indices already resolve
to ids.

**Risk.** A key produced by two tasks in one round means an ambiguous edge.
Treat it as a planning error and refuse at dispatch (see §4) rather than
guessing which producer was meant. Self-edges (a task consuming what it
produces) must be skipped rather than deadlocking themselves.

---

## 4. Validate the round's data flow at dispatch

**Problem.** Once edges come from the contracts, the contracts are load-bearing
and worth checking. Today nothing verifies that a consumed key is produced by
anything.

**Proposal.** At `dispatch_scrum`, refuse the batch and hand the reason back to
the planner when:

- a `consumes` key is produced by no task in this round AND is not already a key
  on the goal scratchpad (cross-round keys are legitimate and common, so the
  existing scratchpad has to be part of the check, not just the batch)
- a key is produced by more than one task in the round (ambiguous edge)
- a task lists itself in `dependsOn`

**Cost.** Small. The scratchpad keys are already read for the review summary,
so the data is at hand.

**Risk.** False positives would block legitimate plans, which is worse than the
current silence. Mitigate by checking the goal scratchpad as well as the round,
and by making the refusal a message to the planner rather than a hard failure of
the goal.

---

## 5. Critical-path-first slot filling

**Problem.** This only became relevant when agents started running several
tasks at once. Slots are now scarce, and `processNextInQueue` takes the first
eligible pending task, which is FIFO by staging order. With a DAG and a limited
number of slots, staging order is an arbitrary basis for deciding what runs
first.

**Proposal.** When filling free slots, prefer the ready task with the most work
behind it, measured as the number of tasks transitively blocked on it. That is
the standard critical-path heuristic and it needs no new data: the blocker sets
in `pendingDeps` already describe the graph.

**Cost.** Contained. One ordering step where pending tasks are selected, plus a
transitive-dependent count computed once per dispatch rather than per pop.

**Risk.** Low, and it degrades to today's behavior when every ready task has the
same weight. Worth measuring rather than assuming: on a shallow round it will
change nothing.

---

## 6. Per-goal fairness in the agent queue

**Problem.** Also created by concurrency. With `maxConcurrentTasks: 3` and a
FIFO pending list, one goal staging six tasks occupies an agent completely, and
a second goal's single task waits behind four of them. There was no starvation
path before, because everything was serial anyway.

**Proposal.** Either round-robin across `goalId` when filling slots, or cap the
in-flight slots any single goal may hold on one agent. The cap is simpler to
reason about; round-robin is fairer when goals differ wildly in size.

**Cost.** Small either way, in the same function as §5.

**Risk.** Interacts with §5: fairness and critical-path can disagree, and the
resolution should be explicit rather than emergent. Suggested rule is fairness
first (pick the goal), then critical-path within it.

**Evidence needed.** I can construct this starvation but have not seen it
happen. Worth holding until a real workload shows it.

---

## 7. See the graph, in all four places

**Problem.** Rounds can now be wide and parallel, and every surface that shows
progress was designed when execution was a line. There is no way to see which
tasks are running, which are blocked, and on what.

This is bigger than one view. Four places render goal progress today, and they
do not all share code:

| Surface | Renders via | Shared? |
|---|---|---|
| GoalBrowser window | `buildGoalRows` in `goal-tree.ts` → `goalProgress` widget | yes |
| Chat inline activity bubble | `buildGoalRows` in `goal-tree.ts` → `goalProgress` widget | yes |
| `goalProgress` widget | `widget-manager.ts:2114`, draws `GoalRow[]` | the renderer for both above |
| `commune` CLI | its own `GoalTask` model in `cli/client.ts`, its own live panel in `cli/commune.ts` | **no** |

So a change to `goal-tree.ts` covers two of the three user-facing surfaces for
free, which is the whole reason that module exists. The CLI is the odd one out
and needs its own work, including a server change: the projection at
`cli-server.ts:529` maps tasks to `{ id, description, status, agentName }` and
drops dependency information entirely, so the CLI cannot show a graph until the
wire shape carries one.

**The model question, which is the real decision.** `buildGoalRows` produces a
flat, depth-annotated list: a tree. A DAG is not a tree. A task with two parents
has no single place in a tree, so this is not a matter of adding a field.

Three options:

1. **Annotated topological list.** Keep the flat row model, order rows so
   dependencies precede dependents, and annotate each task row with its state
   and, when blocked, what it is waiting for. No layout engine anywhere.
2. **Tree with reference nodes.** Render the DAG as a tree and repeat a
   multi-parent task under each parent, marked as a reference. Familiar, but it
   lies about identity: the same task appears to be several.
3. **Real graph layout.** Node positions and edges. Honest, and impossible in
   the CLI panel without a lot of work.

**Recommendation: option 1.** It is the only one all four surfaces can carry,
it needs no new widget, and it keeps the "one graph walk, no drift" property
`goal-tree.ts` was built for. Blocked-on annotation is the information that
actually matters when watching a wide round: not where a task sits in a
picture, but why it has not started. A real graph view (option 3) is worth
revisiting for GoalBrowser alone later, since it is the only surface with the
space for it, and it can be added without disturbing the other three.

**Work, in order:**

- `goal-tree.ts`: topological row ordering, a `blockedOn` annotation on task
  rows, and a state that distinguishes "blocked" from "pending". Covers
  GoalBrowser and Chat at once.
- `widget-manager.ts`: whatever the `goalProgress` widget needs to draw the new
  annotation. Likely small, since rows already carry colour roles and text.
- `cli-server.ts`: carry `dependsOn` (and the derived edges from §3) in the
  `goalStatus` projection.
- `cli/client.ts` + `cli/commune.ts`: extend `GoalTask`, then render the same
  ordering and annotation in the live panel.

**Cost.** The largest item in this plan, and the only one spanning server, two
UI surfaces, a widget, and the CLI.

**Risk.** Low individually, but the drift risk is real: the CLI reimplements
what `goal-tree.ts` owns. Worth considering whether the topological ordering and
blocked-on derivation belong in a shared, UI-agnostic helper that both
`goal-tree.ts` and the CLI can call, rather than being written twice. That is
the same argument that produced `goal-tree.ts` in the first place, and it
applies again one layer down.

## 8. Ordering

1. **Named nodes** (§2). Small, and it improves the case that already works.
2. **Contract-derived edges** (§3). Correctness, pays off on the next wide round.
3. **Dispatch validation** (§4). Natural companion to §3; do them together.
4. **Critical-path scheduling** (§5). Refinement; only bites under load.
5. **Per-goal fairness** (§6). Hold for evidence.
6. **Progress views** (§7). Whenever wide rounds start feeling opaque. Note
   this is four surfaces (GoalBrowser, Chat, the `goalProgress` widget, and the
   `commune` CLI) plus a server-side projection change, not one view.

Items 1 through 3 are one coherent piece of work: they all make a single wide
round something a planner can get right. Items 4 and 5 are scheduling under
contention and share a code path. Item 6 is independent of all of them, and is
itself the largest, because a wide round is only as useful as the ability to
watch it: the CLI in particular cannot show one at all until the wire shape
carries dependency information.

## 9. Acceptance

A round staged as a genuine graph should survive being written the obvious way:

> Three audits in parallel, each producing a findings key. One report consuming
> all three. The planner declares `id` and `consumes` on each and omits
> `dependsOn` entirely.

Success is that the report waits for all three audits without the planner having
declared a single edge, that a typo in a consumed key is refused at dispatch
with the list of keys actually produced, and that the three audits start
together rather than in staging order.

For §7, the same round watched from all three user-facing surfaces should agree:
GoalBrowser, the Chat activity bubble, and `commune` each show the three audits
running at once and the report blocked, naming what it waits for.

## 10. Open questions

1. **Should a derived edge be visible to the planner?** Reporting "3 edges
   derived from data contracts" in the dispatch result makes the graph
   inspectable, at the cost of noise in every round. I lean toward reporting it
   only when at least one edge was derived that was not also declared.
2. **Ambiguous producers**: refuse, or take the last writer? Refusing is
   honest but rejects a plan that might be fine when two tasks legitimately write
   the same key in sequence. I lean toward refusing, since that sequence is
   itself better expressed as an explicit edge.
3. **Should the topological ordering and blocked-on derivation live in a
   shared helper** below `goal-tree.ts`, so the CLI calls the same code rather
   than reimplementing it? That is what `goal-tree.ts` did for GoalBrowser and
   Chat, and the same drift argument applies. It costs one more module.
4. **Does §5 need to be transitive?** Counting direct dependents is cheaper and
   catches most of the benefit. Transitive is more correct on deep graphs and
   costs one traversal per dispatch. I lean transitive, since the traversal is
   per-round rather than per-task.

---

## 11. What landed

| Item | Where |
|---|---|
| §2 Named nodes | `scrum-master.ts` `add_task`: optional `id`, `dependsOn` accepts names or indices, duplicate ids and unknown names refused at stage time |
| §3 Contract edges | `core/task-graph.ts` `deriveContractEdges`, applied in `dispatch_scrum` |
| §4 Data-flow validation | `core/task-graph.ts` `validateDataFlow`, run before the round commits |
| §5 Critical path | `core/task-graph.ts` `transitiveDependentCounts` at dispatch, carried as `priority` on `enqueueTask` |
| §6 Fairness | `agent-abject.ts` `selectNextQueued` |
| §7 All four surfaces | `core/task-graph.ts` shared by `goal-tree.ts` and `cli/commune.ts`; `cli-server.ts` projection; `icons.ts` clock glyph |

### Divergences worth recording

**The scheduler could not compute its own weights.** §5 said "the blocker sets
in `pendingDeps` already describe the graph", which is true, but `pendingDeps`
lives in ScrumMaster and the queue lives in AgentAbject, which knows nothing
about dependents. So the weight is computed at dispatch, where the graph is
known, and travels with the task as `priority`. That is the better split
anyway: the planner owns the graph, and the queue honors a number.

**The queue policy became a pure exported function.** `selectNextQueued` was
going to be a private method, but the policy is the part worth reasoning about
and it should be checkable without standing up an agent to watch it. Extracting
it also settled how fairness and critical path compose, which §6 flagged as
needing an explicit rule rather than an emergent one.

**Open question 3 resolved: yes, a shared helper.** `cli/` had no imports from
`src/` at all, but esbuild bundles it and the tsconfig already covers both, so
`core/task-graph.ts` is imported directly by `commune.ts`. Verified by building
the CLI. The alternative was reimplementing topological order and blocked-on
derivation in the terminal client, which is the drift this module exists to
prevent.

**A rejected round is recorded, not failed.** §4 said refuse and hand the reason
back. It writes the problems to the goal scratchpad under
`scrum/dispatch-rejected` and returns, so the next scrum sees them. Failing the
goal outright would throw away a round's planning over what is usually a typo in
a key name.

**A blocked state needed a glyph.** `blocked` is distinct from `pending`: one
waits on work, the other on a slot, and only the first has a reason worth
showing. There was no suitable icon, so `icons.ts` gained a clock.

### Found while implementing, not fixed

`cancelTask` does not free an in-flight slot when the task never created a
`TaskEntry` — it falls through to the pending scan and returns
`{ success: false }`. Such a slot is only reclaimed by the stale sweep, five
minutes later. Pre-existing, unrelated to this plan, and worth its own change.

### Verification

96 checks across five suites, all passing, `tsc` clean, and the CLI bundles with
the shared import. The graph suites include negative controls: the ordering test
asserts a cycle keeps every node rather than dropping one, and the policy suite
asserts a busy goal still runs when it is the only one waiting, which is the
deadlock the fairness rule could otherwise cause.

Not yet verified end to end: a real planner staging a round with `id` and
`consumes` and no `dependsOn` at all. That is the §9 acceptance test and it
needs a live goal.
