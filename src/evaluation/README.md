# src/evaluation/ - Agent Evaluation Catalog

The acceptance catalog for evaluating agents: a fixed list of scenarios, each
with the intent given to the agent and the criterion an independent verifier
judges the outcome against. It is data only. The `AgentEvaluation` Abject
(`src/objects/agent-evaluation.ts`) owns the runs and serves this catalog
over messages.

## Architecture

```
 AgentEvaluation ── listCases ──► AGENT_EVALUATION_CASES (this directory)
      │ run { driverId, verifierId, options }
      │   for each repetition × condition (fresh | frozen | learning) × case:
      ├─► driver   prepareEvaluation  (isolated fixture + fingerprints)
      ├─► driver   executeEvaluation  (the case's intent)
      ├─► verifier verifyEvaluation   (the case's acceptance, independently)
      └─► driver   cleanupEvaluation
      results persisted in Storage; report per condition
```

The driver and the verifier are two distinct Abjects supplied by the caller;
AgentEvaluation asks each to explain its protocol (`ask`) before a run and
checks the driver's `evaluationProtocol` version and supported conditions.
Within a repetition, every condition must start from the same configuration
and memory fingerprints, so the comparison between conditions is fair. The
report gives, per condition, acceptance rate with a 95% Wilson interval,
false-success count (claimed success the verifier did not accept), latency
percentiles, cost and token totals, and failures by family.

## Files

### agent-cases.ts

- `EvaluationCondition`: `'fresh' | 'frozen' | 'learning'`, the memory
  condition an episode runs under.
- `AgentEvaluationCase`: `id`, `group` (`object`, `repository`, `mixed`,
  `recovery`), `family` (for example `stateful-ui`, `verification`,
  `continuation`), `intent`, `acceptance`.
- `AGENT_EVALUATION_CASES`: the catalog, with ids `agent-01`, `agent-02`, ...
  assigned by position.

Imported by `src/objects/agent-evaluation.ts` and
`src/objects/agent-system.evaluation.test.ts`.

## Adding a case

Append a `[group, family, intent, acceptance]` row to the `cases` array in
`agent-cases.ts`.

- Append at the end. Ids come from the array position, so inserting or
  reordering renumbers every later case and breaks comparisons with stored
  runs.
- Write `acceptance` as something a verifier can check from evidence (real
  input, durable state, command output), never from the agent's own report.
- Keep intents generic: describe the situation, not a particular object,
  agent or skill.
- `src/objects/agent-system.evaluation.test.ts` pins the catalog size, the
  count per group and the positions of some families; update it with the new
  row (`pnpm test:agents`).

## Related

- [../objects/README.md](../objects/README.md): `AgentEvaluation` and the agent objects it evaluates
- [../core/README.md](../core/README.md): `Abject` and the message protocol
