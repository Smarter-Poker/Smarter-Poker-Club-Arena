# Satellite awards preserve their funded components

Isolated PostgreSQL 17 rehearsal of current installed money functions reproduced three defects: pre-start qualifiers incremented their count twice, version 2 satellite fees were subtracted from prize escrow twice, and an empty bounty target's ledger reconstruction counted a phantom bounty contribution.

The candidate migration preserves the roster trigger's pre-start count, retains the RUNNING increment, skips duplicate fee subtraction only for version 2 transfers and counts direct bounty only from matching ledger entries. Legacy fee behavior and matched-entry bounty arithmetic remain unchanged. Source-body guards prevent replacing unexpected deployed definitions.

Eight planned groups passed, including real funded registration, the 175/5/20 bounty split, replay, transaction rollback, insufficient source funding, finalized-target contention, final-place contention and paid-entry contention. Passing groups were resumed without repeated optional tests. Read-only peer review checked the three narrowly changed behaviors.

This is an unapplied, unpushed financial candidate. It does not rewrite historical rows; future escrow calculations for existing events can change. Production application, upper ticket delivery/cash alternatives and remaining B07/B09 acceptance are pending. See `docs/audits/2026-09-10-phase3-satellite-award-funding-evidence.md` for exact hashes, results and limits.
