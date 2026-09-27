-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260429052624 "x10_add_missing_fk_indexes_2026_04_29"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 35430e4abbc994d449a436f559643f98 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Round 6 — Cover the 2 unindexed FKs on hot Club Arena tables.
-- Without covering indexes, cascade deletes do full scans and JOINs on
-- these columns hit the table heap.
CREATE INDEX IF NOT EXISTS idx_chip_escrow_holds_wallet_id
  ON public.chip_escrow_holds (wallet_id);

CREATE INDEX IF NOT EXISTS idx_club_wallet_transactions_actor_id
  ON public.club_wallet_transactions (actor_id)
  WHERE actor_id IS NOT NULL;
