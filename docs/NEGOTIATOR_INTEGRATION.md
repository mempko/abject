# Negotiator Integration Plan

Status: proposed, not implemented. Written 2026-08-12 against `main` at
`0e90ce0` plus the merged health-window fix (PR #9).

The Negotiator, ProxyGenerator, HealthMonitor connection tracking, and
`AgreementStore` exist and are inert. This document records what is broken,
the design decision that governs the repair, and a phased plan.

## 1. Current state

Nine defects, all verified against the tree.

**1. Nothing ever calls `connect`.** No caller anywhere. The only mentions of
the method are its own handler and its own `askPrompt`.

**2. The interceptor install is unreachable in production.**
`negotiator.ts:263` guards on `this.bus instanceof MessageBus`. `'Negotiator'`
is in `workerEligible` (`server/index.ts:615`) and workers default on for any
multi-core machine (`server/index.ts:147`), so `this.bus` is always a
`WorkerBus` and the guard is always false. `connect()` still spawns the proxy
Abject, then falls through to `negotiator.ts:277` and stores the connection
without an interceptor: a proxy is created, billed to the LLM, and orphaned.
The same dead guard appears in `disconnect` (`:322`) and `renegotiate`
(`:380`).

**3. Even on the main thread, `ProxyInterceptor` cannot see the traffic it
exists to reroute.** `WorkerBus.send` has no interceptor chain at all: tier 1
delivers to a local mailbox, tier 2 goes direct worker-to-worker over a
MessagePort (`worker-bus.ts:120-143`), and `worker-pool.ts:135` broadcasts
every object's placement to every other worker so tier 2 is the normal case.
Only main-to-main and main-to-worker traffic passes an interceptor. User
ScriptableAbjects spawn in workers (`factory.ts:980`), so the pairs most
likely to need translation are exactly the pairs the bus cannot see.

**4. `HealthInterceptor` is never constructed.** `recordSuccess` and
`recordError` are therefore never called, `messageCount` stays 0, and
`checkAllHealth` hits the `minMessages` gate and continues forever. The
windowing fix merged in PR #9 is correct and currently unreachable.

**5. The `sourceUpdated` wire is cut at the source.**
`scriptable-abject.ts:889` sends the event from the object to itself. The
inline comment says "Negotiator listens via bus subscription or handler";
there is no such subscription. `Negotiator.handleSourceUpdated` (`:407`)
never fires.

**6. Three uncoordinated copies of connection state, none durable.**
`AgreementStore` (`agreement.ts:115`, 264 lines, complete and well written)
has zero callers. Negotiator keeps `connections: Map`; ProxyGenerator keeps
`generatedProxies` and `proxyMeta`. All in memory, all in worker threads,
both objects supervised `permanent`. One restart and `renegotiate` returns
`'Agreement not found'` for every live proxy, with the proxies still running.

**7. `negotiationId`** exists on the message header (`types.ts:39`,
`message.ts:20,86`) and is never set or read.

**8. The compatibility test is backwards.** `checkCompatibility` (`:424`)
returns true only when both objects share an interface id. Almost no two
objects in this system share one, so every pair reads as "incompatible" and
every `connect()` would spend an LLM generation. Interface identity answers
"are these the same kind of thing", not "can A say what it needs to say
to B".

**9. Nothing reacts to `METHOD_NOT_FOUND`** (`abject.ts:1095`). The one
signal that genuinely means "these two cannot talk" is discarded as an
ordinary rejected request.

## 2. Design decision: resolution, not interception

Two ways to put a translator on the path.

**(A) Interception.** Keep the current design and make it work: add an
interceptor chain to `WorkerBus`, to the peer MessagePorts, and to
`PeerRouter`'s inbound path. Every message in the system pays a per-hop check
so a handful of pairs can be rerouted, and the same reroute logic has to stay
correct in three transports.

**(B) Resolution.** Every source-backed object reaches its collaborators by
name: `dep(name)` -> `requireDep` -> `discoverDep` -> Registry `discover`
(`scriptable-abject.ts:214`, `abject.ts:411`). If that name-to-id step
returns the proxy's id, the sender addresses the proxy directly. No
interceptor anywhere. Works identically on main, in a worker, across a
MessagePort, and across a peer. Zero cost for pairs that are not proxied.

**(B) is the choice.** It also fits what the README already promises ("Not a
shim. A living translator"): a proxy that is a real addressable object in the
send path is more in keeping with "everything is an Abject" than a bus that
lies about recipients.

Two consequences follow:

- The proxy can report its own successes and failures to the HealthMonitor,
  so `HealthInterceptor` is deleted rather than fixed. Connection health then
  means something precise: it tracks pairs that have a translator, which are
  exactly the pairs where "renegotiate" is a coherent response.
- Binding happens in the caller, so it is inherently pair-scoped. See below.

Known limit: (B) binds at name resolution, so an object holding a raw id it
received in a payload or a spawn result bypasses it. This is correct rather
than a gap. Negotiation is a name-level concern.

**Not doing:** adding interceptor support to `WorkerBus`. It is the obvious
repair for defect 3 and the wrong one. It puts a per-message hook on the
hottest path in the system, in the thread deliberately kept clear for
throughput, to serve a feature that fires rarely.

## 3. A proxy is per-pair

The binding key is `(callerTypeId, targetTypeId) -> proxyId`. Only A's
resolution of B returns the proxy; every other caller of B resolves straight
to B. A proxy that sits in front of an object intercepting calls from
everyone is not the goal and, under (B), is not expressible: resolution
happens in the caller, so A asks "who is B" and only A gets a different
answer.

The problem being solved: A calls B, B's API changes, and the communication
is repaired without changing A or B.

## 4. Two remedies, and the rule for choosing

Inserting a proxy is not the only repair. When A's source is ours to change,
fixing A is the better default: a permanent fix, no extra hop forever, no
second LLM-maintained artifact that itself needs regenerating when B changes
again, and the change is inspectable in AbjectEditor's history. The proxy's
real job is the case where neither side can be touched.

The repair path already has what it needs. `ScriptableAbject.updateSource`
(`:389-415`) enforces ownership but accepts ObjectCreator, AbjectEditor, and
AbjectStore, and its own rejection message tells agents to route edits
through ObjectCreator's `edit_source` / `deploy_update` because those carry
owner context. `AbjectStore.restoreVersion` (`abject-store.ts:189`) applies a
prior version to the running object, updates snapshot and registry, and
pushes the replaced source back onto the version ring so the restore is
itself undoable. That is a real rollback for a repair that makes things
worse.

**Repair the caller** when A is source-backed and reachable through
ObjectCreator (a ScriptableAbject or Organism in a local workspace). This is
the default.

**Interpose a pair proxy** when A's source is not ours to change:

- A is a built-in TypeScript system object
- A is a WASM abject (source is a compiled module)
- A is on a remote peer
- B is remote and its owner may change it again independently

The asymmetric case, stated explicitly: if B is remote and A is local, repair
A. If A is remote, you can only proxy on your side, and only for traffic you
resolve.

## 5. Phases

Phases 1 and 2 are independent of each other. Both are prerequisites for
phase 3.

### Phase 1: Pair-scoped detection

A durable record per `(caller, target)` pair: what method missed, what B's
manifest looked like then and looks like now, how many failures, what remedy
has been tried.

Two detection sources:

- `METHOD_NOT_FOUND` (`abject.ts:1095`) reported by the caller, for the cold
  case
- error rate for the degraded case, which is where the PR #9 windowing fix
  finally does work

Replace `checkCompatibility`'s interface-id equality (`negotiator.ts:424`)
with a method-level test: does B expose the method A called, with a
compatible shape. Add the tier that spends no LLM at all, since a pure rename
or an argument reshuffle is derivable from two manifests.

Build in grouping by cause from the start. When B's API changes, several
callers usually break at once, and a single Registry `objectUpdated` event
(`registry.ts:605`) explains all of them. Group broken pairs by cause so the
remedy is chosen once and the log reads "B changed, 4 callers affected"
rather than four unrelated failures.

### Phase 2: Pair-scoped binding via resolution

Negotiator owns `(callerTypeId, targetTypeId) -> proxyId`. The caller's name
resolution consults it, via a hook on the Abject base class next to
`discoverDep` so callers do not reimplement it.

Delete `ProxyInterceptor`, delete `HealthInterceptor`, delete the three dead
`instanceof MessageBus` blocks. This phase removes more code than it adds and
is what makes proxies work across workers and peers at all.

Also in this phase: `_depCache` (`scriptable-abject.ts:129`) never
invalidates, which is a pre-existing staleness bug and a hard blocker for
hot-swapping a binding. It needs an invalidation event.

Durability, folded in here: put `AgreementStore` to work as the single source
of truth and delete the parallel maps. Make ProxyGenerator stateless, taking
the previous source and participant ids as parameters instead of caching
them. Persist through Storage keyed by `typeId` rather than `AbjectId` so
records survive respawn (the same reasoning AbjectStore already uses). On
init, reconcile: for each persisted agreement confirm the proxy is still
registered, and respawn or drop the binding if not.

### Phase 3: The two remedies

Repair path: Negotiator hands ObjectCreator the pair record (A's source, B's
old and new descriptions, the failing call) and asks for a corrected A.

Proxy path: unchanged from today's ProxyGenerator, but the result is bound
per-pair rather than intercepted.

The Negotiator is the arbiter that picks between them and owns the pair's
agreement. It does not do either job itself.

### Phase 4: Verify, and roll back

This is what makes automatic repair safe enough to leave on. After either
remedy, replay the call that failed. If it still fails, undo:
`AbjectStore.restoreVersion` for a repair, drop the binding and kill the
proxy for a proxy.

A remedy that does not verify is worse than no remedy, because it mutates a
working-ish object and leaves two problems.

### Phase 5: Budgets and visibility

Attempts per pair with backoff and a circuit breaker, so a genuinely
incompatible pair does not spend LLM calls forever (`checkAllHealth` would
otherwise retrigger every 5s). Set `negotiationId` so translated messages are
traceable. Surface live pair records and bindings in ObjectBrowser or
ProcessExplorer.

## 6. Verification

The `verify` skill's recipe fits: boot the server in-process and drive
objects over the message bus, no browser client.

- Spawn two objects with deliberately mismatched interfaces, call across,
  assert the pair record appears and the chosen remedy makes the call
  succeed.
- Change B's API under a live caller and assert the same.
- Kill the Negotiator and assert bindings and agreements survive.
- Force a remedy that does not fix the call and assert the rollback fires.

## 7. Open questions

**1. Should repair be automatic, or proposed?** Sharper than the equivalent
question about proxies. A proxy is additive and leaves A and B untouched; a
repair rewrites a user's object without being asked. The version ring makes
it recoverable, but "your object's source changed while you weren't looking"
is a different kind of event. Options: auto-repair with a NotificationCenter
entry and one-click undo, or queue a proposal for approval. Leaning
auto-with-undo for objects the system itself created and propose-only for
objects the user has hand-edited, since the store knows the version history
either way.

**2. Repair A, or repair whichever side is wrong?** If B's API changed by
accident, the right fix is B, not its four callers. The system cannot tell an
intentional API change from a regression, but the user can, and the
grouped-by-cause record from phase 1 is exactly the evidence needed to ask.
Worth deciding whether "revert B" is ever an offered remedy.

**3. Proxy capabilities.** A generated proxy is source-backed, so
`CapabilityInterceptor` applies, and `createProxyManifest`
(`proxy-generator.ts:399`) declares `requiredCapabilities: []`. A proxy in
front of a capability provider gets `CAPABILITY_DENIED` in enforce mode. It
must inherit A's declared capabilities, and the proxy path must not become a
way to launder capability checks.
