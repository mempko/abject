# tests/ - E2E Test Suite

Playwright-based end-to-end tests that verify the system works in a real browser environment.

## Framework

- **Playwright** (`@playwright/test`)
- **Browser**: Chromium (Desktop Chrome profile)
- **Dev server**: auto-started via `npm run dev` (Vite on `localhost:5173`)
- **Reporter**: HTML

## Running Tests

```bash
pnpm exec playwright install   # First time only
pnpm test                      # Runs all specs
```

## Test Files

### bootstrap.spec.ts

Verifies system boot: core objects register (Registry, Factory), capability objects available (HttpClient, Storage, Timer, Console, FileSystem), UIServer running.

### messaging.spec.ts

Verifies inter-object messaging: creates `SimpleAbject` pairs, sends request, verifies reply. Tests Registry lookup returns null for nonexistent objects.

### proxy.spec.ts

Verifies proxy generation infrastructure: ProxyGenerator and Negotiator are registered. Full proxy generation test skipped (requires LLM API key).

### capabilities.spec.ts

Tests capability objects directly: Storage `set`/`get`/`has`/`keys`, Timer schedule/fire/info, Console `log`/`getLogs` filtering, FileSystem `mkdir`/`writeFile`/`readFile`/`readdir`/`stat`/`exists`. HttpClient test skipped (requires network access).

### network.spec.ts

Tests MockTransport: paired transports send/receive messages, transport state machine transitions (`disconnected` → `connecting` → `connected` → `disconnected`). WebSocket test skipped (requires server).

### object-creator.spec.ts

Tests ObjectCreator: registered in system, `listAvailableObjects` returns objects, `getObjectGraph` returns nodes. Code generation test skipped (requires LLM API key).

### self-healing.spec.ts

Tests HealthMonitor: registered in system, tracks connections, calculates health status (error rate, healthy flag, message count).

## Test Pattern

Each test:
1. Navigates to `/`
2. Waits for `window.abjects` to be defined (system bootstrap)
3. Uses `page.evaluate()` to run code in browser context
4. Imports modules dynamically inside `evaluate()` when needed

## Skipped Tests

Tests marked `test.skip()` require either:
- **LLM API keys**: `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
- **External services**: WebSocket server, CORS-enabled HTTP endpoint
