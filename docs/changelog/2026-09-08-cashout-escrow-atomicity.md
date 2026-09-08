# Cashout Escrow And Receipt Atomicity

Applied to PokerIQ-Production on 2026-09-08. Migration: `20260908035339_cashout_escrow_ledger_atomicity.sql`.

The request, approval and refund functions moved balances without declaring the actual escrow counterparty to the shared journal writer. The fallback category was adjustment and the counterparty settlement_suspense. A balanced wallet movement could therefore still produce an unexplained accounting leg.

The release function also caught unique receipt conflicts in a block that covered only the receipt insert. Earlier wallet credits and escrow releases were outside that rollback boundary. Its recovery could report another cashout's receipt after moving the current cashout's chips.

All three functions now declare escrow_hold or escrow_release against the actual chip_escrow ID. The enclosing transaction commits the balance, escrow state, request state, journal, receipt and in-app notification together. Unexpected posting/receipt errors propagate and roll back the call. Context settings are restored for surrounding operations. Per-actor operation locks serialize concurrent retries before the receipt lookup; replay payloads must match the original amount/request. The approval also requires an actual destination wallet update.

Validation: 60 real PostgreSQL fixture cases cover five paths (request, approve, agent denial, player cancellation, missing-member refund), five injected SQLSTATEs at both journal and receipt writes, successful escrow accounting, context restoration, replay and conflicting payloads. Four additional two-session tests exercise overlapping request/approval/denial retries and two different refunds sharing one operation ID. All 64 pass on PostgreSQL 17.11. The combined journal/satellite/cashout suite has 138 passing cases. Permission helpers use isolated fixtures; this is not a complete RLS or production-schema test. Actual wallet writer and ledger enrichment bodies execute in the fixture.

The live compile probe rolled back its own DDL; the migration then applied with inspected-definition hash preconditions. Live readback confirms the intended definitions and unchanged authenticated/service_role grants. Hashes: request b6e9e3bbf4d87df47d5d984f0893f127, approve 702ceb8322f4018595cacb5b140bc29e, release b916271ddbb494851520e5ac237fc37b.

No historical balance or incident was changed. Full cashier authorization, ticket paths, other wallets and historical accounting remain part of the open global audit.
