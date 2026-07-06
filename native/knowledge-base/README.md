# KnowledgeBase (C++/WASM)

A native replacement for the TypeScript `KnowledgeBase` system object,
written in C++ against `sdk/cpp` and compiled to WebAssembly. It is a
**bundled system package**: the committed `main.wasm` is ingested at every
boot (with `replaces: "KnowledgeBase"`), so it transparently takes over
every workspace's knowledge store: the WorkspaceManager spawns
`KnowledgeBase` by name as always, and the Factory resolves the name to this
module. The desktop app ships it under `resources/native`.

After changing the sources, rebuild the committed module (requires the WASI
SDK at `~/tools/wasi-sdk` or `$WASI_SDK`):

```bash
pnpm smelt   # forge --build-only: recompile, validate, re-embed the manifest
```

## What it demonstrates

- A compiled-language abject replacing a built-in system object with zero
  changes anywhere else: same manifest surface (`remember`, `recall`,
  `match`, `get`, `forget`, `update`, `list`), same events, same discovery.
- All capability access by message passing: persistence goes through the
  workspace `Storage` abject (one key per entry), cross-peer sync through
  `SharedState`, exactly like every other object. No filesystem, no SQLite.
- A hand-written field-weighted BM25 inverted index (`bm25.hpp`) with the
  same 10/1/5 title/content/tags weighting the TS version tuned FTS5 to,
  including FTS5-style `[bracketed]` snippets.

## Benchmark (vs TS KnowledgeBase with node:sqlite FTS5)

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

## Behavioral differences from the TS version

- `match` supports case-insensitive literals and `A|B` alternations (the
  documented agent usage); other regex metacharacters degrade the pattern to
  a literal substring, the same fallback TS applies to invalid regexes.
  (Exceptions don't exist in this build, and `std::regex` reports invalid
  patterns only by throwing.)
- Distillation runs on load and is throttled to every 30 minutes piggybacked
  on writes, instead of a wall-clock interval timer.
- The LLM `ask` answer comes from the host's default handler over this
  module's (deliberately rich) manifest description, rather than a custom
  store-summary prompt.
