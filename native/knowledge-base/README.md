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
  answered as a duplicate.
- **Distillation** runs on load and at most every 30 minutes, piggybacked on
  writes rather than a timer. It archives `learned` entries never accessed
  within 7 days, `learned`/`reference` entries idle for 30 days, and the least
  useful entries over the 1000-entry active cap. User-authored entries,
  patterns, `user`/`person` facts, entries marked useful and entries with
  learning history are never touched. Archived entries are purged after 180
  days or past 2000 archived (user-authored ones never).
- **`ask`** is answered by the host from the manifest plus `ask-guide.md`
  (declared under `ask` in `abject.json`), at the balanced tier. The module
  never sees `ask`.

## Message surface

| Group | Methods |
|---|---|
| Store | `remember` (dedup by normalized title + type; optional `origin`: user, agent, reviewer, scrum), `update` (optional `expectedRevision`), `forget` (first call archives, second deletes), `archive` |
| Retrieve | `recall` (BM25, `previews: true` for `{id, title, snippet}`), `match` (literal or `A\|B`), `get`, `list`, `listTags`, `weave` (patterns by context, plus linked patterns; `from`, `hops` up to 2) |
| Curation | `markUseful` (bumps `usefulCount`, which protects an entry from distillation) |
| Pattern learning | `beginPatternApplication`, `assessPatternApplication`, `recordPatternApplication`, `patternHistory`, `applyLearningDecision` |
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
