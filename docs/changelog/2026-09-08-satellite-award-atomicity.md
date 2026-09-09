# Satellite Award Funding And Receipt Atomicity

The production award function could keep a newly inserted target seat, target prize-pool/rake counters and rake record after its satellite funding transfer or payout receipt failed. It could also award a partially funded seat or silently ignore a conflicting journal/payout key.

The migration makes transfer and receipt failures propagate, rejects a missing or insufficient source pool, and requires both inserts to succeed. The enclosing transaction rolls back the new seat and every associated movement on failure. Already committed registrations retain their existing replay and admission behavior. No existing seats or balances are rewritten.

Verification: 15 original partial-commit reproductions on PostgreSQL 17.11; 17 passing corrected cases including 10 SQLSTATE failures, insufficient/missing funding, conflicting keys, successful funding, and replay after registration closes. All prior 57 shared journal regression cases pass. The required CI journal test now executes both suites. The production schema compile probe was self-aborting; the migration was then applied successfully and read back.

This closes the new-award partial-commit paths. It does not fund already outstanding guarantee deficits or prove the entire tournament lifecycle. Separate hand-stack/rake/BBJ settlement and all remaining wallet paths remain under audit. A guarantee must be funded from an authorized real balance before a new seat can be committed; no unbacked award is manufactured.

CI follow-up: the estate TypeScript runner has no Docker executable. The required journal gate now launches a temporary native PostgreSQL cluster with no TCP listener and removes it after testing. Linux server binaries are pinned by a separate npm lockfile (PostgreSQL 17.10); local verification used PostgreSQL 17.11. The satellite migration also preserves the existing executable late-registration boundary assertion. No required test is skipped or weakened.
