# Implementation Plan: Abject `agy` Diagnostics & Capabilities

**Date**: 2026-08-12  
**Spec**: [`docs/superpowers/specs/2026-08-12-agy-diagnostics-and-capabilities-design.md`](file:///Users/faust/projects/abject/docs/superpowers/specs/2026-08-12-agy-diagnostics-and-capabilities-design.md)  
**Target Repository**: [`abject`](file:///Users/faust/projects/abject)  

---

## Task 1: LLM Streaming Progress Keepalive in `LLMObject` (TDD)
- **Goal**: Prevent GoalManager timeouts by periodically sending `progress` events during LLM streaming.
- **Files**:
  - [`src/objects/llm-object.ts`](file:///Users/faust/projects/abject/src/objects/llm-object.ts)
  - [`src/llm/antigravity-cli.test.ts`](file:///Users/faust/projects/abject/src/llm/antigravity-cli.test.ts)
- **Action**:
  1. Add progress heartbeat timer (every 5000ms) in `LLMObject.stream()`.
  2. Emits `progress` (`llm-waiting`) to `callerId` whenever stream chunks arrive or keepalive timer ticks.

## Task 2: Sub-process Teardown & Buffer Draining in `AntigravityCliProvider` (TDD)
- **Goal**: Ensure non-blocking I/O and process kill fallback (`SIGTERM` -> `SIGKILL`) if cancelled.
- **Files**:
  - [`src/llm/antigravity-cli.ts`](file:///Users/faust/projects/abject/src/llm/antigravity-cli.ts)
  - [`src/llm/antigravity-cli.test.ts`](file:///Users/faust/projects/abject/src/llm/antigravity-cli.test.ts)
- **Action**:
  1. Add process termination helper with `SIGKILL` fallback after 2s if `SIGTERM` doesn't exit.
  2. Update unit tests in `src/llm/antigravity-cli.test.ts`.

## Task 3: Local Verification & Build
- **Commands**:
  - `npx tsx src/llm/antigravity-cli.test.ts`
  - `npx tsc --noEmit`
  - `pnpm bind`

## Task 4: Push to PR #10
- **Commands**:
  - `git commit -am "fix(llm): add streaming keepalives and sub-process teardown for agy"`
  - `GH_TOKEN=... git push origin feat/add-antigravity-cli-provider`
