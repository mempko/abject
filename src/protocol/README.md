# src/protocol/ - Protocol Negotiation and Health

Two system Abjects that keep objects talking: the `Negotiator`, which connects
two objects and puts an LLM-generated proxy between them when their interfaces
differ, and the `HealthMonitor`, which pings system objects for liveness (and
asks the Supervisor to restart the silent ones) and watches connection error
rates to trigger renegotiation.

Both are global singletons spawned under supervision in `server/boot.ts`, and
both are worker-eligible, so with workers on (the default) they run in a pool
worker.

## Architecture

```
               connect(source, target)
 any object ─────────────────────────► Negotiator
                                         │ describe ──► source, target
                                         │ same interface id? ── yes ──► direct agreement
                                         │ no
                                         ├─ generateProxy ──► ProxyGenerator (LLM)
                                         ├─ spawn proxy ────► Factory (ScriptableAbject)
                                         ├─ proxy route on the main bus, copied to every pool worker
                                         ├─ trackConnection ► HealthMonitor
                                         ├─ addDependent ──► source, target (to hear sourceUpdated)
                                         └─ connectionEstablished ► both participants

 every bus, on each send (src/runtime/proxy-routes.ts):
   request/event source ⇄ target ──► re-addressed to the proxy
   proxy's reply/error to the source ──► recordSuccess / recordError ──► HealthMonitor

 HealthMonitor, every checkInterval (5 s):
   liveness:   ping each ready monitored object (5 s timeout)
               maxPingFailures in a row ──► childFailed ──► Supervisor ──► Factory.respawn
                                            Supervisor ──► markObjectReady ──► HealthMonitor
   connections: error rate over the window >= errorThreshold
               ──► renegotiate(agreementId, last 5 errors) ──► Negotiator
                   ──► regenerateProxy ──► ProxyGenerator, kill old proxy, spawn new,
                       point the route at the new proxy

 either end changes its source ──► sourceUpdated (to its dependents) ──► Negotiator
   ──► renegotiate (proxied connection) or reconnect (direct connection)
```

## Files

### negotiator.ts

`Negotiator` (`NEGOTIATOR_ID`, interface `abjects:negotiator`).
- **`connect { sourceId, targetId }`**: introspects both with `describe`.
  Interfaces are compatible when the two manifests' `interface.id` match; then
  the agreement is direct. Otherwise it asks ProxyGenerator to
  `generateProxy` from both descriptions, spawns the result through the
  Factory as a ScriptableAbject owned by the Negotiator, and installs a proxy
  route (`MessageBus.setProxyRoute`, which copies it to every pool worker):
  requests and events between the two go to the proxy in both directions,
  wherever the objects run, and the proxy's answers to the source are counted
  for HealthMonitor. It asks HealthMonitor to `trackConnection` (best effort),
  becomes a dependent of both ends, and sends `connectionEstablished` (the
  agreement) to both participants. Returns
  `{ success, agreementId?, proxyId?, error? }`; a failure comes back as
  `success: false` and as a `connectionFailed` event to both participants.
- **`disconnect { agreementId }`**: removes the route, stops depending on ends
  that have no other connection, and asks the Factory to kill the proxy.
- **`renegotiate { agreementId, errorContext }`**: asks ProxyGenerator to
  `regenerateProxy` with the error context, kills the old proxy, spawns the
  new one and points the route at it.
- **`sourceUpdated`** (event, from either end as a dependent): re-introspects
  the sender and renegotiates each proxied connection it takes part in; a
  direct connection is reconnected, which adds a proxy only if the interfaces
  no longer match.
- Runs on the main thread (it is left out of the `workerEligible` list in
  `server/boot.ts`) because it installs routes on the main bus; `onInit`
  requires that.
- Dependencies (`requireDep` in `onInit`): Registry, Factory, ProxyGenerator.
  HealthMonitor is discovered lazily (each needs the other).
- Connections live in memory only; they do not survive a restart.

### health-monitor.ts

`HealthMonitor` (`HEALTH_MONITOR_ID`, interface `abjects:health-monitor`).
- **Config** (`HealthConfig`, constructor overrides): `errorThreshold` 10 (%),
  `windowSize` 60 s, `minMessages` 10, `checkInterval` 5 s, `pingTimeout` 5 s,
  `maxPingFailures` 36.
- **Liveness**: `monitorObject { objectId, maxFailures? }`,
  `markObjectReady`, `unmonitorObject`, `getObjectLiveness`,
  `getAllObjectLiveness`. Only objects marked ready are pinged. After
  `maxFailures` consecutive misses the object is gated (no more pings) and the
  Supervisor gets `childFailed` with code `LIVENESS_FAILURE`; the Supervisor
  marks it ready again after the respawn. Pings in one tick run one after
  another, and a new round never starts while one is running.
- **Connections**: `trackConnection`, `recordSuccess`, `recordError`,
  `getStatus`, `getAllStatus`, `forceRenegotiate`. Message and error counts
  are pruned to the rolling window together, so the rate reflects the window
  rather than the connection's lifetime. Crossing the threshold (with at
  least `minMessages` in the window) sends `renegotiate` to the Negotiator
  with the last five errors and resets the counters.
- `startMonitoring` starts the timer; `onStop()` stops it. It subscribes to
  the Registry and drops objects on `objectUnregistered`.
- `INCOMPREHENSION_ERRORS` and `isIncomprehensionError()` name the error
  codes that mean "the other side did not understand" (`PARSE_ERROR`,
  `UNKNOWN_METHOD`, `INVALID_PAYLOAD`, `SCHEMA_MISMATCH`, `TYPE_ERROR`,
  `SEMANTIC_ERROR`).
- At boot, `server/boot.ts` registers the core system objects with
  `monitorObject` + `markObjectReady` and then sends `startMonitoring`.

### health-monitor.test.ts

Regression tests for the rolling window (old traffic cannot hide a broken
connection). Runs under `pnpm test`.

## Using it

From any Abject:

```typescript
const negotiatorId = await this.requireDep('Negotiator');
const result = await this.request<{ success: boolean; agreementId?: string; proxyId?: string; error?: string }>(
  request(this.id, negotiatorId, 'connect', { sourceId: a, targetId: b }),
);
```

Watch a new long-lived object for liveness with `monitorObject` then
`markObjectReady` to the HealthMonitor; give it a Supervisor child spec
(`addChild`) as well, or a missed-ping report has nothing to restart.

## Gotchas

- **Routes cover the main thread and the pool workers.** The dedicated P2P and
  UI workers keep their own buses and apply no routes; their objects are not
  meant to be connection ends.
- **Error rates need traffic.** HealthMonitor computes a connection's error
  rate once it has seen `minMessages` (10) answers from the proxy; a quiet
  connection is never renegotiated for errors. Liveness pinging works
  independently.
- Nothing in the tree calls `connect` on its own; agents and objects reach the
  Negotiator by discovery and its `ask` guide.

## Related

- [../core/README.md](../core/README.md): `Abject`, `ProtocolAgreement`, introspection
- [../runtime/README.md](../runtime/README.md): MessageBus, interceptors, Supervisor
- [../objects/README.md](../objects/README.md): ProxyGenerator, Factory, ScriptableAbject, WorkerRecovery
