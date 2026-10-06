# Qualify the authenticated EV cashout settlement boundary

The launch audit had separate EV calculation and ordinary insurance accounting
checks, but no connected authenticated cashout/settlement/replay evidence.
This change adds an EV-specific actor to the existing native fixture workflow:
real GoTrue sessions call the actual engine HTTP handler, deterministic winning
and losing hands settle through the current retained-hand and post-commit owners,
and durable bank/ledger observations verify conservation and replay invariance.

Existing native service qualification runs first and keeps every assertion. The
additional container has no network, production credentials or production data.
It retains sanitized failure stages and verifies owned cleanup. This is not full
application restore proof or a product certificate. Supporting unrelated schema
triggers and browser/WebSocket behavior remain outside this precise boundary.

Local source composition, syntax, compiler and owning runner checks are required;
the genuine Linux service execution result must come from the hosted native
workflow before claiming the EV launch gap closed.

The first hosted run (37405723911) passed the original native smoke and reached genuine authentication plus critical-authority readback, then failed PostgREST readiness before either EV actor. The readiness request now follows the maintained full fixture and authenticates with the fixture service identity; anonymous grants are unchanged. A fixed numeric HTTP status and allowlisted PostgREST or SQLSTATE code are retained for readiness failure. The first artifact did not retain its HTTP reason, so the initial failure cause remains unproven. Both owned cleanup checks passed. This result does not qualify either EV outcome.
