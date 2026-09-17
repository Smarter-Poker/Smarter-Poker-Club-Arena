# Cash failed-run evidence

The active candidate uses `supabase/components/cash-failed-run-intake.sql` at the existing job259 terminal row transition. It adds no schedule, heartbeat, scan, or financial retry. Install it only with its paired rollback and the co-qualified positive cash-check evidence packet through the existing protected path.

`cash-pot-failed-run-intake.sql` in this directory is retained solely for an explicit, finite administrative import of already retained historical failures. It is not an active runtime entry point and must not be scheduled. No retained job259 failures existed at the 2026-09-17 02:18 UTC readback. The native installer refuses unattested earlier failure receipts when creating a new outcome store; an administrative import needs a separately reviewed outcome-attestation path before mixing it with the active handler.

The runtime handler keeps exact run/snapshot identity and immutable original/update receipts. The append-only outcome ledger records `delivered` only after exact receipt readback; ordinary queue errors record `intake_failed`. An outcome-store failure rolls back that queue attempt, preserves the failed cron row, and emits a bounded first-party warning. Missing or mismatched outcomes are undelivered, not successful notification. No automatic retries are provided.

Use the existing hosted PG17 accounting job for source qualification. The native fixture builds pinned official pg_cron1.6.4 with the provider's documented schema alignment and heap-table patch, and observes actual SPI scheduler writes. Source construction is not proof that compilation, native tests, installation or production delivery passed.
