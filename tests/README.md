# tests/ - Shared Test Data

Data shared by tests and evaluation scripts. The tests themselves live beside
the code they test, as `*.test.ts` files (in `src/objects/`,
`src/objects/widgets/`, `src/network/`, `src/llm/`, `src/protocol/` and
`client/`), and run on Node's built-in test runner through tsx:

```bash
pnpm test           # every suite in those directories
pnpm test:agents    # the agent-system suites (src/objects/agent-system.*.test.ts)
```

## Files

- **fixtures/**: labeled data read by tests and scripts. See
  [fixtures/README.md](fixtures/README.md).

## Related

- [fixtures/README.md](fixtures/README.md): what each fixture is and who reads it
- [scripts/README.md](../scripts/README.md): `evaluate-learning.ts`
