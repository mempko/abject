# KnowledgeBase (C++/WASM)

The workspace KnowledgeBase, written in C++ against `sdk/cpp` and compiled
to WebAssembly. It is a **bundled, required system package**: the committed
`main.wasm` is ingested at every boot under the type name `KnowledgeBase`
(`replaces: "KnowledgeBase"`), the WorkspaceManager spawns it by that name
for every workspace, and boot stops with an error if it fails to load, since
there is no TypeScript implementation to fall back on. Its message
vocabulary for TypeScript callers lives in `src/core/knowledge.ts`. The
desktop app ships it under `resources/native`.

After changing the sources, rebuild the committed module (requires the WASI
SDK at `~/tools/wasi-sdk` or `$WASI_SDK`):

```bash
pnpm smelt   # forge --build-only: recompile, validate, re-embed the manifest
```

## What it demonstrates

- A compiled-language abject as a core system object: it took over from the
  TypeScript KnowledgeBase with the same manifest surface (`remember`,
  `recall`, `match`, `get`, `forget`, `update`, `list`, `markUseful`,
  `archive`, `weave` and the learning protocol), the same events and the
  same discovery, and is now the only implementation.
- All capability access by message passing: persistence goes through the
  workspace `Storage` abject (one key per entry), cross-peer sync through
  `SharedState`, exactly like every other object. No filesystem, no SQLite.
- A hand-written field-weighted BM25 inverted index (`bm25.hpp`) with the
  same 10/1/5 title/content/tags weighting the former TS version tuned FTS5 to,
  including FTS5-style `[bracketed]` snippets.

## Benchmark (vs the former TS KnowledgeBase with node:sqlite FTS5)

End-to-end request latency through the bus, previews recall with limit 10,
medians over 200 queries:

| operation | 1000 entries | 5000 entries |
|---|---|---|
| recall (BM25) | **5.0x faster** (0.65 ms vs 3.25 ms) | **2.3x faster** (3.17 ms vs 7.36 ms) |
| match | **3.0x faster** (0.32 ms vs 0.96 ms) | **3.0x faster** (0.60 ms vs 1.81 ms) |
| remember | parity (0.17 vs 0.14 ms/entry) | 0.34 ms/entry |
| list (50 full entries) | slower (0.42 ms vs 0.07 ms) | slower (0.71 ms vs 0.30 ms) |

Recall sits on every agent/chat conversation init, so the recall win is felt
system-wide. The `list` regression is the honest cost of the WASM boundary:
the in-process bus passes payloads by reference while the module must
serialize 50 full entries to JSON; operations returning small results
(recall previews, match) come out far ahead because the compute dominates.

## Behavior notes

- `match` supports case-insensitive literals and `A|B` alternations (the
  documented agent usage); other regex metacharacters degrade the pattern to
  a literal substring. (Exceptions don't exist in this build, and
  `std::regex` reports invalid patterns only by throwing.)
- Tokenizing reads UTF-8: letters of every script stay inside their word,
  typographic punctuation and `_` separate words, and case folds for Latin,
  Greek and Cyrillic.
- Distillation runs on load and at most every 30 minutes, piggybacked on
  writes. Sync publishing is throttled to every 2 s; a flush the throttle
  deferred asks the Timer capability for one wakeup (`timerFired`), so an
  idle store still publishes its last change and otherwise sets no timers.
- The legacy whole-array key is imported only into an empty store; a
  re-import would bring back entries forgotten since the migration.
- `ask` is answered by the host over the manifest plus `ask-guide.md`
  (declared under `ask` in `abject.json`), at the balanced tier.
- Pattern learning: a repeated `beginPatternApplication` under the same
  identity adds a declaration to that application instead of conflicting;
  verdicts are `helpful`, `no_effect`, `harmful` and `inconclusive`; `weave`
  accepts `from` (patterns already in use, to expand their links), orders
  link expansion by how often the two patterns were used together, and
  returns each pattern's `linkedFrom` and recent `counterexamples`, plus
  `broken` links that name an archived pattern. Link names resolve by id
  (`id:` prefix allowed), title, or alias.
