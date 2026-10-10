# tests/fixtures/ - Labeled Test Data

Fixtures read by tests and evaluation scripts. Each is plain data, loaded by
path (`new URL('.../tests/fixtures/<file>', import.meta.url)`).

## Files

### learning-judgment.json

A labeled corpus of 23 cases for judging how a learning review should treat
evidence: whether what happened supports, contradicts or leaves open what an
agent expected, and what should then happen to the knowledge at stake. Each
case is an object with:

- `id`: a stable name (`stale-tests`, `preview-is-not-loss`, ...).
- `prediction`: what the agent expected to happen.
- `claim`: the piece of knowledge the case bears on.
- `evidence`: what was actually observed.
- `operation` (8 cases): a command or protocol call (`command` or `method`
  and `payload`, with `exitCode` or `status`) and the naive
  `runtimeOutcome`. These are the cases where an exit code or status means
  something other than success or failure, such as `git diff --no-index`
  exiting 1 because the files differ.
- `expected`: the right judgment. `verdict` is `supported`, `contradicted` or
  `unresolved`; `dispositions` lists the acceptable knowledge actions
  (`confirm`, `no_change`, `revise`, `narrow`, `supersede`, `dispute`);
  `scope`, when present, is where a correction applies (`project:A@r7`,
  `command:git-diff-no-index`, ...); `patternVerdict`, when present
  (`inconclusive`, `harmful`), is what the case says about a pattern's
  usefulness.

Read by:

- **`scripts/evaluate-learning.ts`**: `evaluate(cases, answers)` scores
  answers against the corpus. An answer is right when there is exactly one
  for the case, its `verdict` matches, its `disposition` is one of the
  acceptable ones, its `scope` matches whenever the case has one and the
  disposition changes something, and its `patternVerdict` matches when the
  case has one. Run as a script, it reads this file and an answers file and
  exits 1 unless every case is right.
- **`src/objects/agent-system.world-model.test.ts`**: checks the evaluator
  itself. Answers copied from `expected` must all pass, and five deliberate
  mistakes (on `preview-is-not-loss`, `stale-tests`, `injection-not-use`,
  `successful-commit-wrong-hunks` and `staged-stats-not-agreement`) must be
  caught; and judging the eight `operation` cases by `runtimeOutcome` alone
  must pass only `diff-one-not-zero`.

## Adding a fixture

Put the file here, read it by a path relative to the reader's own module, and
add it to the list above with what reads it.

## Gotchas

- The world-model test names case ids and expects exactly eight cases with an
  `operation`. Renaming those cases, or adding or removing an `operation`
  case, means updating that test too.
- The corpus scores given answers; nothing here calls a model.

## Related

- [tests/README.md](../README.md): where the test suites live and how to run them
- [scripts/README.md](../../scripts/README.md): `evaluate-learning.ts`
