# tests/a-count-that-has-not-changed-is-not-a-write.law.test.ts

fn_sync_club_table_counts recomputed a denormalised table_count onto the club
row on every table status change, but fn_live_table_count counts every status
that is not closed or deleted, so the engine's constant waiting/running cycle
never moved the number: the UPDATE assigned the value the row already held.
Measured on production 2026-09-29, all five clubs had stored equal to
recomputed, and there had been 128,715 such UPDATEs against ten live rows in
eleven hours. A no-op UPDATE still writes a row version, runs the fifteen
triggers that fire on a clubs UPDATE, and holds an exclusive lock on that one
row until the writing transaction commits - and because the engine changes
table status inside the hand loop, that lock was held for the rest of the hand,
making public.clubs the most contended tuple behind Lock/transactionid. This law
pins that both stores are now conditional while the recount still happens, that
all three triggers stay bound, that SECURITY DEFINER and the pinned search_path
survive the replace, that nothing is backfilled, and that the disposable-cluster
harness proves a status flip rewrote the row before and does not after, while
the count is still maintained when it genuinely changes.
