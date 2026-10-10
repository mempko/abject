# hack/ - P2P Security Audit Harness

Adversarial self-test of the peer-to-peer layer, run with `pnpm hack`. The
orchestrator starts a signaling server and two Abjects processes, a victim
and an attacker, coordinates them over IPC, and prints a report of what the
attacker could and could not reach. It is a developer tool: nothing in the
application imports it.

## How it works

1. `security-audit.ts` deletes the two data directories (below), then
   starts a `SignalingServer` in-process on the base port.
2. It forks `hack-victim.ts` (with `tsx`) with its own ports, data directory
   and `ABJECTS_SIGNALING_URLS` pinned to that server. The victim boots,
   creates a `Public Zone` workspace (access mode `public`) and a
   `Private Zone` workspace (`shared`, empty whitelist), keeps the default
   workspace `local`, stores a secret flag in the global Storage, connects to
   signaling, and sends `ready` with its peer id and object ids.
3. It forks `hack-attacker.ts` with the victim's details. The attacker boots
   its own instance, connects to the victim over P2P and runs the attack
   phases, then sends its results back.
4. The orchestrator prints each result as PASS, VULN, INFO or FAIL by phase,
   lists the VULN findings, shuts both processes down and deletes both data
   directories. The whole run has a 180-second timeout.

Ports and data come from the environment, so a run can sit beside a live
instance:

| Variable | Effect |
|---|---|
| `WS_PORT` | Base port, default 7730. Signaling listens on it; the victim's backend takes base+1 and the attacker's base+11, and each also binds its `WS_PORT`+4 (CLI gateway) and +5 (HTTP gateway). |
| `ABJECTS_DATA_DIR` | Parent of the data directories: `hack-victim` and `hack-attacker` under it. Unset, they are `.abjects-hack-victim` and `.abjects-hack-attacker` in the working directory. |

For example `WS_PORT=7921 ABJECTS_DATA_DIR=/tmp/hack pnpm hack`. No API key is
needed.

Attack phases (ids as printed):

| Phase | Attacks |
|---|---|
| 0 Signaling | S1 peer enumeration, S2 impersonation |
| 1 Reconnaissance | R1 route capture |
| 2 Enumeration | E1 public registry list, E2 private registry probe, E3 local registry probe, E4 WorkspaceShareRegistry probe |
| 3 Exploitation | X1 permission cache race, X2 undeliverable fallback, X3 spoofed source, X4 reply bypass, X5 method filter gap |
| 4 Exfiltration | F1 direct storage read, F2 introspect pivot |

## Files

- **security-audit.ts**: entry point (`pnpm hack`) and orchestrator: data
  directory cleanup, the signaling server, process lifecycle, the report.
- **hack-bootstrap.ts**: `bootAbjectsCore()`, shared by both processes. It
  runs the real headless bootstrap (`bootServer` from `server/boot.ts`), so
  each instance is the shipped backend: worker pool, dedicated P2P worker,
  SettingsManager, PermissionBroker, AuthGate, DialogBroker and the package
  ingest with the native KnowledgeBase. Then it registers its own sender on
  the main bus, finds the objects the audit drives in the Registry by name,
  and offers `shutdown()`, the same teardown a SIGTERM runs.
- **hack-victim.ts**: the target: three workspaces in different access modes
  and a secret to protect.
- **hack-attacker.ts**: the hostile peer: the attack sequence above.

## Gotchas

- **Each instance is a whole headless backend.** It binds three ports, writes
  an instance file in its data directory, and boots a worker pool, so a run
  takes a few seconds per instance and two audits need different `WS_PORT`
  bases. The data directories are deleted at the start and end.
- **The first P2P offer can time out.** The attacker's signaling probes
  briefly bump its own instance off the signaling server, so the first offer
  may wait out the transport's 20-second timeout before a retry connects; the
  attacker waits up to 40 seconds for the connection.
- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`, when set, reach the LLM object as
  they do in a normal boot; the audit itself does not need a model.

## Related

- [../src/network/README.md](../src/network/README.md): transports, signaling, peer routing
- [../server/README.md](../server/README.md): the real bootstrap
- `server/signaling-server.ts`: the signaling server it runs in-process
