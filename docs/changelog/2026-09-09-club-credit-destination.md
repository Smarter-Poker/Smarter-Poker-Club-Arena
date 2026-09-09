# A club credit must write its destination wallet

The shared credit function could continue after its club_members update matched no row. Its wallet-existence helper returns a boolean; it does not create missing membership. A nullable journal balance could therefore accompany a claimed credit with no destination balance write.

The migration now raises CLUB_CREDIT_DESTINATION_MISSING immediately when that update affects no row. PostgreSQL rolls back the idempotency claim and all caller work. It does not redirect the credit to another economy or manufacture a replacement balance. The function signature and non-club branch are unchanged.

Local evidence: the missing-wallet cashout test failed before the change and passes after it; all 68 isolated Phase 2 database cases pass. Additional cases cover rakeback, tournament-prize and refund rollback. The full guarded migration is applied twice in that disposable harness. Installed baseline fingerprint was checked read-only as ca0a0d6fe1f01c1f2bed49e7db1fd7e8; corrected fingerprint is ffc49583c6142ea0929f247edc65e219.

This fix can be released independently of occupancy protocol changes. Publication and production application require separate evidence; this document does not claim either yet.

Standalone release verification: bash scripts/dev/probe-club-credit-destination-postgres.sh passes from the independent release worktree based on main 7c5d0e43e. It starts a disposable socket-only PostgreSQL instance, loads the pinned installed credit routine, applies the guarded migration twice, and checks real balance/journal/idempotency outcomes for valid credits, committed replay, missing destinations and a retained inactive account. It has no dependency on the unpublished occupancy schema or engine.

Verified release: PR #3925 merged as e970c09bfab3828707b471f976771826d7e699de, CI 34307621500 succeeded, and frontend build 2026-09-09T03:40:14Z advertised that merge (run 34307860062). Production migration 20260909034315 installed the destination-write guard; read-only verification confirmed ffc49583c6142ea0929f247edc65e219. This supersedes the pending-publication statement above.
