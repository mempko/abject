## KnowledgeBase Usage Guide

### Three lookup modes (use them in this order)
1. **recall** searches by keywords (BM25 full text, title-boosted). Results carry a `snippet` and `score`. Pass `previews: true` to scan cheaply, and `tags` or `type` to narrow.

  const hits = await call(await dep('KnowledgeBase'), 'recall', {
    query: 'ui preferences', limit: 5, previews: true,
  });

2. **match** finds exact identifiers and precise strings: a case-insensitive literal, or literals separated by `|` to match any of them. Reach for this when you know the exact name.

  const exact = await call(await dep('KnowledgeBase'), 'match', { pattern: 'GraphViewer|abjects:registry' });

3. **get** fetches one full entry by id. Scan with previews first, then get the winners.

  const entry = await call(await dep('KnowledgeBase'), 'get', { id: hits[0].id });

### The iterate pattern
Search, read the previews, and refine: when results are thin, reformulate with different terms (synonyms, the object's registered name, a distinctive phrase) and search again. Fetch full entries only for the results you will actually use.

### Remember something (create or update knowledge)

  await call(await dep('KnowledgeBase'), 'remember', {
    title: 'User prefers dark UI themes',
    content: 'When creating widgets, default to dark color schemes with light text.',
    type: 'learned',
    tags: ['ui', 'preferences'],
  });

Types: 'learned' (behavioral lessons), 'fact' (discovered facts), 'insight' (agent analysis), 'reference' (pointers to resources), 'pattern' (Alexander/Coplien-style generative pattern-language entries, written through the reviewer's save_pattern/update_pattern actions rather than composed by hand: each names the context it applies to, the forces in tension, what to do therefore, the evidence behind it, and the patterns it links to). Remembering a title that already exists for that type updates the entry in place.

### Weave patterns for a goal

  const woven = await call(await dep('KnowledgeBase'), 'weave', {
    query: 'build a dashboard from live portfolio data', limit: 3,
  });
  // woven.patterns: matched patterns plus one hop of linked patterns, each with
  //   via (how it arrived), linkedFrom (patterns leading to it) and
  //   counterexamples (recent applications where it did not help)
  // woven.dangling: link names with no pattern written yet
  // woven.broken: links that point at an archived pattern

Pass `from: [<pattern ids>]` with the patterns a plan already follows to see what their links lead to next.

### Update / forget / list

  await call(await dep('KnowledgeBase'), 'update', { id: entryId, content: 'Updated...' });
  await call(await dep('KnowledgeBase'), 'forget', { id: entryId });
  // The first forget archives (out of recall, restorable); forgetting an
  // archived entry deletes it for good, learning history included.
  const all = await call(await dep('KnowledgeBase'), 'list', { type: 'learned', limit: 20 });

### When to remember (durable knowledge only)
- User preferences or personal facts (location, name, role): tag these with "profile" so every future task has them, even when the task wording does not mention them
- Facts about this workspace or an external project you are working in
- Stable capabilities or approaches that help future unrelated tasks
- References to external resources or object capabilities

Ephemeral problems (runtime errors, connection failures, debugging context) belong in the goal scratchpad, so the knowledge base stays a record of durable lessons.

### When to recall
- Before starting a task, check whether relevant knowledge exists
- When uncertain about user preferences or a project's conventions
- When a task is similar to a previous one
