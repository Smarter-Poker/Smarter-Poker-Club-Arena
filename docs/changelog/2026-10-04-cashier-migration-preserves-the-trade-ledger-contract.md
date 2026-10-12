# Cashier Migration Preserves The Trade Ledger Contract

The first production installation attempt for
`20261004124327_cashier_authority_and_retry_keys_are_exact.sql` was refused by
PostgreSQL with `42P13` before commit. The migration tried to replace
`fn_club_trade_ledger(uuid, integer, integer)` with a nine-column row type while
production already exposed the ten-column contract that includes
`metadata jsonb`. The installer reported the refusal and the single migration
transaction rolled back, so neither schema changes nor migration history were
committed.

The unapplied migration now preserves the established row type, metadata,
251-row sentinel limit, deterministic `created_at DESC, id DESC` ordering,
function OID, dependent objects, grants, owner, stable security-definer posture,
search path, and five-second function lock timeout while moving authorization
to the active Cashier hierarchy. The native PostgreSQL qualifier builds the
exact predecessor shape, proves replacement without a drop, verifies catalog
identity and ACLs, reads metadata through the real RPC, and checks pagination
and tied-timestamp ordering before exercising the exact-intent and concurrency
matrix.
