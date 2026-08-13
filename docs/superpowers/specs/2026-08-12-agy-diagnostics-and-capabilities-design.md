# Design Spec: Abject `agy` Diagnostics & Capability Integration

**Date**: 2026-08-12  
**Author**: Andrey (@AndreBurnt) & Antigravity  
**Status**: Draft  
**Target Repository**: [`abject`](file:///Users/faust/projects/abject)  

---

## 1. Problem Statement

During live agent execution of multi-step goals via **Antigravity CLI** (`agy`) in Abjects (PR [#10](https://github.com/mempko/abject/pull/10)), two primary failure modes were identified:

1. **Watchdog Timeout on Long `agy` Goals**:
   - `GoalManager` / `JobManager` in Abjects enforces step idle timeouts (80s / 296s) and an overall watchdog limit (600s).
   - `AntigravityCliProvider` streams NDJSON chunks (`step_update`), but `LLMObject` does not emit progressive keepalive heartbeats to `GoalManager` during streaming turns.
   - When `agy` executes deep multi-turn reasoning or multi-file inspections, Abjects' goal watchdog marks the step as idle and cancels the goal.

2. **Host Capability Gap (`ShellExecutor`)**:
   - Abjects agents (`WebAgent`, `SkillAgent`, `ObjectAgent`, `ObjectCreator`, `AgentCreator`, `TaskReviewer`) report they lack host shell capabilities when a goal requires running shell commands (`git`, `pytest`, `gh`).
   - Although `ShellExecutor` exists in [`src/objects/capabilities/shell-executor.ts`](file:///Users/faust/projects/abject/src/objects/capabilities/shell-executor.ts), default agent rosters in [`src/objects/agent-abject.ts`](file:///Users/faust/projects/abject/src/objects/agent-abject.ts) do not include `ShellExecutor` by default.

---

## 2. Technical Architecture & Solutions

### 2.1 Keepalive Heartbeats in `LLMObject` (`src/objects/llm-object.ts`)

In `LLMObject.complete()` and `LLMObject.stream()`, when a `callerId` (e.g. `GoalManager` or `AgentAbject`) initiates an LLM request:
- A `setInterval` timer (every 5,000ms) emits a `progress` event:
  ```ts
  event(this.id, callerId, 'progress', {
    phase: 'llm-waiting',
    message: `LLM request in progress (${Math.round((Date.now() - start) / 1000)}s)`,
  })
  ```
- Every incoming `text_delta` or `step_update` event from `AntigravityCliProvider.stream()` also triggers an immediate progress touch to `callerId`, continuously resetting Abjects' step watchdog while `agy` is processing.

### 2.2 Default Capability Wiring (`src/objects/agent-abject.ts` & `src/objects/skill-agent.ts`)

In `AgentAbject` and default agent creation methods:
- Wire `ShellExecutor` as a supported capability for system agents (`SkillAgent`, `ObjectAgent`, `ObjectCreator`).
- Allow agents to delegate shell tasks to `ShellExecutor` when goal instructions specify terminal or host environment actions.

### 2.3 Non-blocking I/O in `AntigravityCliProvider` (`src/llm/antigravity-cli.ts`)

- In `runCliIdleStreaming` and `streamOnce`, ensure `proc.stdout` and `proc.stderr` lines are drained immediately on `data` events, and that buffer boundaries do not drop trailing lines before process exit.

---

## 3. Advisor Council Review Synthesis

### Advisors: Martin Fowler, Jez Humble, Kent Beck

- **Martin Fowler (Architecture & Decoupling)**:
  - *Finding*: Keep `ShellExecutor` capability clean and security-scoped, allowing agents to request shell operations via explicit messages without leaking raw host access to unprivileged web widgets.
- **Jez Humble (Continuous Delivery & Process Isolation)**:
  - *Finding*: Stream heartbeats every 5s to beat Abject's 30s/80s timeout thresholds cleanly. Ensure sub-process teardown (`SIGTERM` fallback to `SIGKILL`) cleans up zombie `agy` child processes if a goal is cancelled.
- **Kent Beck (TDD & Verification)**:
  - *Finding*: Write unit tests for `LLMObject` streaming progress emission and `AntigravityCliProvider` stream chunk parsing before implementing changes.

---

## 4. Acceptance Criteria

1. **Unit Tests**: All unit tests pass in `src/llm/antigravity-cli.test.ts`.
2. **Type Safety**: `npx tsc --noEmit` completes with 0 errors.
3. **Build**: `pnpm bind` completes cleanly.
4. **LLM Progress Events**: `LLMObject` emits keepalive `progress` events during streaming completions every 5 seconds.
