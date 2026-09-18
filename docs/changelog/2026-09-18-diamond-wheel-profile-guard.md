# Diamond wheel accepts its authenticated ledger operation

Paid Diamond Spins reached the private ledger writer but failed when it credited
the host owner's wallet. The profile guard still named the earlier wheel entry
points and rejected `fn_wheel_spin_v2` with SQLSTATE 42501. That unhandled error
rolls the complete spin transaction back; it is not a successful spin receipt.

Migration `20260918230314` adds exactly that reviewed caller to the existing
allowlist. It asserts the installed wheel and guard definitions, verifies the
ledger writer remains private, preserves all other guard bytes, and records the
change through the existing guard declaration function. No wallet balances,
prizes, probabilities, ownership, operation identity, or execution grants change.

The existing isolated PostgreSQL accounting qualification now supplies actual
authenticated JWT-role claims for the complete v3 wheel probe. Previously it set
the SQL role only, so nested SECURITY DEFINER calls appeared as a service context
to the real guard. The corrected probe reproduces the production refusal before
the migration and passes afterward for all primary and Upgrade outcomes, all
four bonus games, Double Down, replay, claimed Mint-funded entry, and welcome.
Direct currency/VIP writes remain refused; the mirror remains unchanged and the
private ledger writer remains unavailable to authenticated callers. The runner
verifies that every public/auth table returns to its original rows after rollback.

No live wager, purchase, claim, player session or production balance was used for
qualification. Production migration installation and publication are separate
delivery steps owned by the main task.

Installed once at 2026-09-18T23:03:14Z. The MCP-assigned history version is
`20260918230314`; its complete statement is byte-identical to the qualified SQL.
The SQL header and declaration retain the original reserved source reference
`20260918225134`. Readback confirmed guard hash `aba2e58e24c04bc28a94a70e74a0e3f1`,
unchanged wheel body and private-ledger permissions.
