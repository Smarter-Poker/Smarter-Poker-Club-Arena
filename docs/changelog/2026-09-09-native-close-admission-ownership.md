# Native close and admission ownership

Status: locally implemented and verified; not deployed. Phase 2 remains in progress.

An active seat now references its parent's derived cash/tournament admission key through a native foreign key. Closing, deleting logically, converting to a template, or changing the asset identity of an occupied table cannot commit. Concurrent admission and closure serialize at the database constraint. Existing empty parents initialize on first use; only occupied parents are backfilled. Migration proofs reject unrelated game or seat mutations and roll back the complete migration.

The unpublished close-helper draft now asserts that engine departures have completed instead of performing SQL payouts. The cash clear-seat alias refuses cash cleanup; tournament cleanup remains available. Managed close authorizes the caller, locks game before table, revalidates the game and caller, and refuses occupied tables without taking seat locks. The planner's closed-table reopening compensation is removed only after native admission constraints exist.

Verification: 111 real PostgreSQL 17 departure tests passed, including concurrent join/close in both orders, stale game context, cash-to-tournament races, physical chair uniqueness, application role restrictions, saved templates, old empty parents, hostile backfill rollback, original receipts, lost responses, and wallet/seat rollback. The harness also exercised 203,451-scale parent inventory and 471,876-scale seat inventory with valid physical chair keys. Server TypeScript completed with exit code 0; git diff --check passed.

Final reviewed pg_get_functiondef fingerprints:

- managed close: 96be8943f1b86538d2b825c894d21f7a
- tournament-only clear: 66923ea85a2278f0992b5e802f3340a7
- contract projector: 6a8019cb24b5a8a42645b9de3aaf48ef
- cluster planner: ae91ea39aef3746371029528cb8e343d

The close helper prosrc fingerprint is 2904d38e22d59c753795957b9f57ad0f.

Remaining release evidence: combined Phase 2 acceptance, staged schema and engine/client adoption, required GitHub PostgreSQL job, Hetzner publication and live verification. No production accounting rows were adjusted for this verification.
