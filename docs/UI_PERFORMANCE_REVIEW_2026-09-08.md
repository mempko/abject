# UI performance investigation — September 8, 2026

The running AppImage's dominant sampled CPU cost is Chromium graphics composition after hardware graphics initialization failed. The recent agent changes also added message-related overhead; a synchronous-handler regression was corrected during this review. That correction does not repair the graphics initialization failure.

## Evidence from the running app

`~/tmp/abject.log` records ANGLE failing to create an OpenGL backing context, `EGL_NOT_INITIALIZED`, exhaustion of EGL display types, and the GPU process exiting at startup. A replacement process reports software WebGL fallback and repeated `GPU stall due to ReadPixels` diagnostics. This happens before the first agent goal runs.

A three-second `/proc/<pid>/task/<tid>/stat` CPU sample of the running app measured:

| Thread/process | CPU, where 100% is one core |
| --- | ---: |
| Graphics process 92329, `VizCompositorTh` 92357 | 99.6% |
| Its 16 `Thread<00>`–`Thread<15>` rendering threads | roughly 28–32% each |
| Renderer process 92789, main thread | 30.0% |
| Backend process 92262, hottest sampled thread | 8.7% |
| Backend process 92262, main thread | 7.3% |

These are interval samples, not lifetime `ps %CPU` averages. The backend was not the process saturating the core. The log also records frame coalescing, including 265 stale queued updates in one report and up to eight frames in flight. That establishes a rendering backlog; coalescing itself is the existing backlog protection.

The exact reason EGL cannot initialize remains unresolved. This review did not change driver configuration, force an alternative graphics backend, or restart the running app.

## Worker and message architecture

- The log confirms eight general workers and 28 direct peer channels. Worker count and UUID-based placement are unchanged.
- Objects on one worker communicate through local mailboxes without `postMessage` serialization.
- Known objects on other pool workers use direct `MessagePort` channels. Payloads cross a structured-clone boundary.
- Main-thread and dedicated-worker destinations use the existing main-thread bridge. BackendUI and P2P have dedicated workers. Dynamically created widgets remain local to their owning worker; their registrations update main-thread routing.
- Mailbox processing awaits arrival, dispatches handlers without awaiting their completion, and resolves reply messages through the same mailbox. The recent changes did not serialize whole object handlers or replace this transport.
- Generated JavaScript still runs in the restored in-process Node `vm`; there is no separate JavaScript process per call.

`src/runtime/*`, `server/node-worker-adapter.ts`, `server/backend-ui.ts`, `server/node-storage.ts`, the client/compositor, and Electron startup have no working-tree changes against HEAD in this review.

## Costs introduced by the agent work

1. **Scripted synchronous handlers were forced through async wrappers.** This created extra Promise continuations for otherwise synchronous UI/event handlers and delayed their completion. Both initial installation and source replacement now preserve synchronous returns. Async work is still counted until settlement so source activation cannot race it. Regression coverage checks sync return/throw, cross-realm async resolve/reject, replacement, and the activation gate.
2. **Progress attribution keeps per-request context.** Requests now add a map entry with task identity, and progress events filter matching pending requests. This fixes cross-task heartbeat contamination but adds allocations and work proportional to outstanding requests when a heartbeat arrives. It does not add an external authorization round trip to every UI message.
3. **Agent callbacks and persistence add messages.** Runtime-owned JobManager callbacks perform provenance checks. Model accounting resolves workspace ownership and reserves/reconciles usage. These happen during agent operations, not for every render or mouse event.
4. **Checkpoint payloads can be large.** A checkpoint includes conversation, specialist state, payloads and configuration. TaskSession clones and persists the record and currently returns the full record, although routine runtime checkpoints only consume its ID and revision. A compact checkpoint acknowledgment is a useful future optimization that can retain durable snapshots.
5. **Goal persistence republishes accumulated state.** Resource reservations, observations and task evidence persist the learning record and synchronize goal metadata containing the scratchpad. Full transcripts increase serialization, storage and observer refresh costs over a goal's life. Separating frequent accounting updates from full evidence publication deserves measurement with long goals; it was not the dominant CPU consumer in this live sample.

## Timing check

A local synthetic harness bundled the current mailbox/worker transport with either HEAD's or current `Abject`/`ScriptableAbject`. It exercised complete request/reply paths, including a real Node worker thread, warmed each case and reported the median of seven batches. No provider or network request was involved.

| Case | HEAD | Current, after synchronous-handler fix |
| --- | ---: | ---: |
| Small cross-worker scripted request/reply | 22.05 µs | 22.96 µs |
| 256 KiB cross-worker echo request/reply | 312.66 µs | 321.41 µs |

Local request/reply runs were on the order of 1–5 µs. The machine's substantial concurrent graphics load caused variation between runs, so these measurements establish scale, not a precise speedup or a statistically significant percentage regression. They do not reproduce the desktop frame workload or simulate the complete eight-worker topology.

## Follow-up priority

The primary UI bottleneck to address is failed hardware graphics initialization. Once the active graphics backend is verified, measure the compositor with the actual desktop workload. If software rendering must remain supported, evaluate a lower-cost rendering mode, including render resolution, multisampling and ambient animation rate. Avoid using bus concurrency or queue-size changes to mask renderer backpressure.

The synchronous-handler correction is in the working tree on `main`, without commits. Validation: 145 regression tests, TypeScript checking, and server build.
