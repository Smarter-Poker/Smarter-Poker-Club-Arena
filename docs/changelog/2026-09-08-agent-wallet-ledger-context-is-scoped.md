# Agent wallet ledger context is scoped

2026-09-08

Agent-wallet sends and take-backs declared transaction-local ledger category, counterparty, correlation, idempotency and skip settings, then returned without restoring the caller's values. A surrounding tournament setting also tagged an unrelated player-wallet transfer as belonging to that tournament. An isolated PostgreSQL reproduction failed with `Agent send leaks ledger context` before the change.

Both active cores now snapshot all eight touched or inherited ledger settings before entering the money section, clear unrelated tournament/settlement context for that movement, and restore the original values after the wallet writes. The existing credit draw/send and claim/repayment legs remain in the same transaction. Failure still rolls back the whole operation. Existing service-only core grants are preserved. Public cashier wrappers continue to authorize and serialize requests.

Validation: 82 isolated PostgreSQL cases passed across player and agent destinations, credit-funded sends, full repayment, replay, all eight context fields, and 70 injected failures across wallet, journal and receipt writes. The preceding 246 database checks also passed. Production test-money writes were not used.

This closes a shared-transaction journal classification gap. It does not change credit rates, historical balances, commission policy or the remaining cash-hand crash-durability work.

Engineering basis: PostgreSQL transactions commit related writes as one unit; transaction-local settings last until transaction end, so nested money functions must explicitly restore their caller's settings. References: https://www.postgresql.org/docs/current/tutorial-transactions.html and https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADMIN-SET .

Production verification: migration 20260908125130 applied, with the uncommitted filename aligned to the authoritative database record. Live body hashes are send c6bb171c71aa0d6022296b29269a016b and claim 29e28090d6d7316ff108918f5ca839f1. Both cores remain service-only; anonymous and authenticated direct execution are denied.
