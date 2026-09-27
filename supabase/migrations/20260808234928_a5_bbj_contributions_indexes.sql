-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260808234928 "a5_bbj_contributions_indexes"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 fb1baee278b70f63ff6960b851dfbeda of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- A5: bbj_contributions had NO index on created_at and none on hand_id, so both
-- the new drift audit and any per-hand reconciliation check were forced into a
-- sequential scan of a 96 MB / ~384k-row table. Small enough that the build
-- takes a second or two, but without these the hourly audit would seq-scan
-- forever and the per-hand check simply times out.
CREATE INDEX IF NOT EXISTS idx_bbj_contrib_created_at
  ON public.bbj_contributions (created_at);

CREATE INDEX IF NOT EXISTS idx_bbj_contrib_hand_id
  ON public.bbj_contributions (hand_id)
  WHERE hand_id IS NOT NULL;
