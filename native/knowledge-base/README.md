# native/knowledge-base/ - KnowledgeBase (C++/WASM)

The workspace KnowledgeBase: agent memory for facts, lessons, insights,
references and the pattern language. Written in C++ against `sdk/cpp` and
compiled to WebAssembly, it is the only implementation (the TypeScript one
was deleted). It is a **bundled, required system package**: the committed
`main.wasm` is ingested at every boot under the type name `KnowledgeBase`
(`replaces: "KnowledgeBase"`), and boot stops with an error if it is missing
or fails to load (`server/boot.ts` checks for it right after ingest).
TypeScript callers read its message shapes from `src/core/knowledge.ts`
(`KNOWLEDGE_BASE_ID`, `PROFILE_TAG`, `KnowledgeEntry` and friends).

## How it works

- **Spawning.** `KnowledgeBase` is in `INFRA_OBJECTS`
  (`src/objects/workspace-profiles.ts`), so WorkspaceManager spawns it by name
  in every workspace whose profile includes it; the Factory resolves the name
  to this module and hosts it in a `WasmAbject` (`src/objects/wasm-abject.ts`).
  TaskReviewer spawns after it because it discovers it at init.
- **Persistence** goes through the workspace `@Storage` abject, one key per
  entry (`knowledge-base:entry:<id>`), so a write serializes one entry, never
  the store. The legacy whole-array key (`knowledge-base:entries`) is imported
  once, and only into an empty store. `Storage.getPrevious` is used to recover
  a pattern whose stored body was flattened by an earlier bug.
- **Sync** across peers goes through `@SharedState`, namespace
  `knowledge-base`, one register per entry (`entry:<id>`; a deletion publishes
  a tombstone). On start it subscribes and reads the namespace whole with
  `getAll` to catch up on anything missed while offline. Publishing is
  throttled to every 2 s; a flush the throttle deferred asks `@Timer` for one
  wakeup (`timerFired`), so an idle store sets no timers.
- **Identity.** It asks `@Identity` for the peer id and stamps entries with it
  for provenance and for breaking equal timestamps.
- **Ranking** is a hand-written field-weighted BM25 inverted index
  (`bm25.hpp`), title/content/tags weighted 10/1/5 (the weights the former
  FTS5 version was tuned to), with FTS5-style `[bracketed]` snippets.
- **Patterns** (type `pattern`) are stored as structured JSON and rendered as
  prose when presented (`pattern.hpp`, mirroring `src/core/pattern.ts`).
  Presented entries carry a `knowledgeRef` (id, update time, revision), and
  patterns also a `patternRef` receipt that `beginPatternApplication` requires.
- **Learning.** `applyLearningDecision` asks `@GoalManager`
  (`getLearningEffect`) for the effect to apply; GoalManager answers only when
  the request came from TaskReviewer through the KnowledgeBase. Applied effects
  are journaled on the entry with a receipt keyed by `effectId`, so a retry is
  answered as a duplicate. `observe_pattern` records a reviewer's verdict on a
  pattern the goal did not formally apply (shown, or followed undeclared) in
  the pattern's `observations`, never as a recorded use.
- **Evidence.** Each entry can carry `evidence` { held, missed, shownHeld,
  shownMissed, lastTestedAt }: how often the predictions and assumptions that
  rested on it held. `held`/`missed` count the ones that cited the entry;
  `shownHeld`/`shownMissed` the ones where it was only shown (a suspect,
  weighted a quarter). Absent means untested, so stores written before it
  load unchanged. TaskReviewer's `observe_entry` effect
  { id, outcome: 'held'|'missed', cited } arrives through the same
  `applyLearningDecision` round trip as the other effects and bumps one
  counter and `lastTestedAt`. It changes no claim: no revision, no
  `updatedAt` change (a `knowledgeRef` read for another effect stays valid),
  allowed on user-authored entries, and no receipt in the learning history;
  the newest 100 observation effect ids are kept with the counters so a
  redelivery is answered as a duplicate. An archived or missing entry answers
  `Knowledge target unavailable` (TaskReviewer abandons the effect). Readers
  get derived fields, rounded to 3 decimals:
  `confidence = (1 + held + 0.25 shownHeld) / (2 + held + missed + 0.25 (shownHeld + shownMissed))`;
  effective tests `n = (held + missed + 0.25 (shownHeld + shownMissed)) * 0.5^(daysSinceLastTested / 60)`;
  `uncertainty = 1 / (1 + n)` (1 when untested); `flagged = missed >= 2 && missed > held`.
  Full entries (`get`, `list`, `recall`, `match`, `weave`, change events)
  always carry it; `recall` previews only once the entry was tested. When
  the claim changes (a new title or content through `update`, a `remember`
  that rewrites an existing entry, or a reviewer's `update_entry`, which is
  also how a supersession's replacement is revised) the counters and
  `lastTestedAt` reset to zero and `claimAt` is stamped: the old holds and
  misses tested the old claim. The observation effect ids stay, so a
  redelivered old observation is still a duplicate. Tag-only changes, and a
  pattern write that only moves its own learning record, keep the counters.
  Sync folds a peer's counters in (last-writer-wins on `updatedAt` cannot
  carry them): for the same `claimAt` each counter takes the larger value,
  counters for a newer claim replace ours and those for an older claim are
  ignored. Two observations made on different peers from the same count are
  counted once.
- **Receipts stay small.** A receipt keeps the prediction-level evidence
  (`{hash, digest}` per cited record: expectation, outcome, verdict,
  explanation, attribution; GoalManager stores the whole record once under
  `evidence:<sha256>`) and the entry's prior text without its own learning
  record. The newest 20 receipts stay whole, older ones keep identity, action
  and evidence, and past 200 the oldest fold into `learning.rolledUp` (counts
  and effect ids). A pattern's recorded uses compact the same way (40 whole,
  400 kept, the rest folded into verdict tallies). Sync compares receipts by
  effect id, so a compacted receipt and the whole one it came from are the
  same receipt. Stores written before this are compacted once at load, with
  `updatedAt` unchanged so selected versions (`knowledgeRef`) stay valid.
  `evidenceHashes` lists the hashes receipts cite, for GoalManager's sweep.
- **Reads do not rewrite entries.** `recall`, `match`, `get` and `weave` bump
  `accessCount` in memory and write all counters as one small key
  (`knowledge-base:access`) at most once a minute through a `@Timer` wakeup;
  on load the map wins wherever it is ahead of an entry. Replies carry a
  learning summary (revision, scope, disputes, supersessions, receipt count,
  and `goals`: how many distinct goals left receipts on the entry) unless
  `includeLearning: true` asks for the whole history. `recall` with
  `minGoals` keeps only entries met in at least that many goals: knowledge
  that keeps recurring, which is what a pattern grows from.
- **Untracked reads.** `recall`, `weave`, `match`, `get`, `list` and
  `listTags` take `track: false` for a read that leaves no trace: no
  `accessCount` bump, and the log line names neither the query nor any
  entry title (`Recall (untracked) => 3 entries`). Private conversations and
  their goals read existing knowledge this way; the default stays
  `track: true`.
- **Distillation** runs on load and at most every 30 minutes, piggybacked on
  writes rather than a timer. It archives `learned` entries never accessed
  within 7 days, `learned`/`reference` entries idle for 30 days, and the least
  useful entries over the 1000-entry active cap (fewest marked useful first;
  among equals a `flagged` entry goes before the rest however often it was
  read, then the least read). User-authored entries,
  patterns, `profile`-tagged entries, `user`/`person` facts, entries marked
  useful and entries with learning history are never touched. Archived entries are purged after 180
  days or past 2000 archived (user-authored ones never).
- **`ask`** is answered by the host from the manifest plus `ask-guide.md`
  (declared under `ask` in `abject.json`), at the balanced tier. The module
  never sees `ask`.

## Message surface

| Group | Methods |
|---|---|
| Store | `remember` (dedup by normalized title + type; optional `origin`: user, agent, reviewer, scrum), `update` (optional `expectedRevision`), `forget` (first call archives, second deletes), `archive` |
| Retrieve | `recall` (BM25, `previews: true` for `{id, title, snippet}`; without a query, `order: 'worth'` ranks user-written, then reviewer-confirmed useful, then recent; `order: 'uncertain'`, with or without a query, ranks what is relied on most and tested least first: `(1 + accessCount + 2 * usefulCount) * evidence.uncertainty`), `match` (literal or `A\|B`), `get`, `list`, `listTags`, `weave` (patterns by context, plus linked patterns; `from`, `hops` up to 2); `recall`, `get` and `list` take `includeLearning` |
| Curation | `markUseful` (bumps `usefulCount`, which protects an entry from distillation) |
| Pattern learning | `beginPatternApplication`, `assessPatternApplication`, `recordPatternApplication`, `patternHistory`, `applyLearningDecision` (including `observe_entry`), `evidenceHashes` |
| Events | `entryAdded`, `entryUpdated`, `entryRemoved` |

It also handles `timerFired` (its own Timer wakeup) and `changed` (SharedState
notifications); neither is in the manifest.

## Files

- **knowledge-base.cpp**: the object: manifest, handlers, persistence, sync,
  distillation and the learning protocol. Expands `ABJECT_OBJECT(KnowledgeBase)`.
- **bm25.hpp**: UTF-8 tokenizer and the field-weighted BM25 index with snippets.
- **pattern.hpp**: the structured pattern format (`kbpat` namespace): parse,
  render, aliases and links; `parse_legacy()` carries pre-format entries
  across once, at load.
- **abject.json**: package metadata (`required: true`, `ask` guide and tier,
  `build` command) with the manifest embedded by `pnpm smelt`.
- **ask-guide.md**: the usage guide appended to the `ask` prompt. It is
  runtime content, read at ingest; keep it accurate to the manifest.
- **main.wasm**: the committed build. Running never needs a compiler.

## Rebuilding

After changing the sources, rebuild the committed module (requires the WASI
SDK at `~/tools/wasi-sdk` or `$WASI_SDK`):

```bash
pnpm smelt   # forge --build-only: recompile, validate, re-embed the manifest
```

Commit `main.wasm` and `abject.json` together, and bump `version` in
`abject.json` when the surface changes (an older copy of the type elsewhere
is then shadowed rather than winning). The desktop app ships this directory
as `resources/native/knowledge-base`; the headless archive as
`lib/native/knowledge-base` (built files and `.md` only).

## Benchmark (at the migration, vs the former TS KnowledgeBase on node:sqlite FTS5)

End-to-end request latency through the bus, previews recall with limit 10,
medians over 200 queries:

| operation | 1000 entries | 5000 entries |
|---|---|---|
| recall (BM25) | **5.0x faster** (0.65 ms vs 3.25 ms) | **2.3x faster** (3.17 ms vs 7.36 ms) |
| match | **3.0x faster** (0.32 ms vs 0.96 ms) | **3.0x faster** (0.60 ms vs 1.81 ms) |
| remember | parity (0.17 vs 0.14 ms/entry) | 0.34 ms/entry |
| list (50 full entries) | slower (0.42 ms vs 0.07 ms) | slower (0.71 ms vs 0.30 ms) |

The `list` cost is the WASM boundary: the in-process bus passes payloads by
reference while the module serializes 50 full entries to JSON. Operations
returning small results (recall previews, match) come out ahead because the
compute dominates. Keep large payloads off this boundary.

## Behavior notes

- `match` supports case-insensitive literals and `A|B` alternations; other
  regex metacharacters degrade the pattern to a literal substring. Exceptions
  are disabled in this build, and `std::regex` reports invalid patterns only
  by throwing.
- Tokenizing reads UTF-8: letters of every script stay inside their word,
  typographic punctuation and `_` separate words, and case folds for Latin,
  Greek and Cyrillic.
- A repeated `beginPatternApplication` under the same `applicationId` adds a
  declaration to that application (up to 20) instead of conflicting. Verdicts
  are `helpful`, `no_effect`, `harmful` and `inconclusive`.
- `weave` needs a `query` or `from`, takes `limit` (default 5, at most 20)
  matched patterns, orders link expansion by how often the two patterns were
  used together, caps linked output at three times `limit`, and returns each pattern's
  `via`, `linkedFrom` and up to three recent `counterexamples`, plus
  `dangling` (link names no pattern holds yet) and `broken` (links to archived
  patterns). Link names resolve by id (`id:` prefix allowed), title or alias.

## Related

- [../README.md](../README.md): bundled packages and how they load
- [../../sdk/cpp/README.md](../../sdk/cpp/README.md): the C++ SDK
- [../../docs/WASM_ABI.md](../../docs/WASM_ABI.md): host/guest contract
- [../../docs/PACKAGES.md](../../docs/PACKAGES.md): package format, `ask` and `required`
- `src/core/knowledge.ts`, `src/core/pattern.ts`: the TypeScript side of the vocabulary
- `src/objects/task-reviewer.ts`: writes patterns (`save_pattern` / `update_pattern`) and sends `applyLearningDecision`
