# hack/ - P2P Security Audit Harness

Adversarial self-testing of the P2P layer (`pnpm hack`). The orchestrator
starts a signaling server plus two full Abjects processes, a victim and an
attacker, coordinates them over IPC, and prints a formatted security audit
report of what the attacker could and could not do.

## Files

- **security-audit.ts**: entry point and orchestrator; spawns the processes,
  drives the attack scenarios, formats the report.
- **hack-bootstrap.ts**: shared bootstrap for the victim/attacker processes.
- **hack-victim.ts**: the target node with normal objects and data.
- **hack-attacker.ts**: the hostile node attempting identity spoofing,
  unauthorized discovery, and message forgery against the victim.
