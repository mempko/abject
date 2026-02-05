# src/protocol/ - Protocol Negotiation and Health

Manages the protocol layer: how objects establish connections, agree on communication protocols, and recover from failures. This is where the **self-healing** behavior lives.

## Files

### negotiator.ts

Connection establishment between objects.

- **`connect(sourceId, targetId)`**: fetches manifests from Registry, checks compatibility (shared interface IDs)
  - **Compatible**: creates direct agreement, no proxy
  - **Incompatible**: generates proxy via ProxyGenerator, installs `ProxyInterceptor` on MessageBus
- **`disconnect(agreementId)`**: removes interceptor, kills proxy, cleans up
- **`renegotiate(agreementId, errorContext)`**: hot-swaps proxy (kill old → generate new with error context → install new interceptor)
- **Events**: `connectionEstablished`, `connectionFailed` sent to both participants
- **Well-known ID**: `NEGOTIATOR_ID`

### agreement.ts

Protocol agreement utilities and storage.

- **Utility functions**: `isExpired()`, `needsHealthCheck()`, `createAgreementId()`, `validateAgreement()`, `renewAgreement()`, `mergeBindings()`
- **`AgreementStore`**: indexed by ID and by participant
  - `store()`, `get()`, `remove()`
  - `getForParticipant()`, `getBetween()` - lookup queries
  - `getExpired()`, `getNeedingHealthCheck()` - maintenance queries
  - `recordHealthCheck()` - timestamp tracking

### health-monitor.ts

Connection health monitoring and self-healing trigger.

- **Config**: `errorThreshold` (10%), `windowSize` (60s), `minMessages` (10), `checkInterval` (5s)
- **Per-connection tracking**: `messageCount`, `errorCount`, timestamped errors
- **Rolling window**: prunes errors outside `windowSize`
- **Trigger**: when `errorRate >= errorThreshold` and `messageCount >= minMessages` → calls `Negotiator.renegotiate()` with recent error context → resets counters
- **Methods**: `getStatus`, `getAllStatus`, `forceRenegotiate`
- **`INCOMPREHENSION_ERRORS`**: `PARSE_ERROR`, `UNKNOWN_METHOD`, `INVALID_PAYLOAD`, `SCHEMA_MISMATCH`, `TYPE_ERROR`, `SEMANTIC_ERROR`
- **Well-known ID**: `HEALTH_MONITOR_ID`

## Self-Healing Flow

```
HealthMonitor (every 5s) →
  checkAllHealth() →
    detect errorRate >= 10% →
    build errorContext from last 5 errors →
    Negotiator.renegotiate(agreementId, errorContext) →
      kill old proxy →
      ProxyGenerator.regenerateProxy(agreementId, errorContext) →
        LLM generates improved proxy with error context →
      install new ProxyInterceptor →
    reset counters
```
