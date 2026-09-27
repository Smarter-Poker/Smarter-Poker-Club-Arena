-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260818234311 "rake_override_defaults_and_checks"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 ed155046b9bb69eb17bd0d689ee20c0a of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Step 1 of 2 for per-table/per-club rake overrides (see the companion
-- backfill). DDL only, kept in its own short transaction with a lock timeout:
-- `tables` is written continuously by the live engine and a combined
-- bulk-UPDATE + ALTER deadlocked against it on the first attempt.
--
-- -1 means "inherit": fall through to the club default, then to the published
-- schedule in server/src/config/RakeConfig.ts. 0 is a real setting (a rake-free
-- table), which is why unset needed a sentinel rather than being spelled 0.
--
-- The CHECKs are defence in depth only. Both tables are UPDATE-able by any club
-- admin through RLS, so the load-bearing guard is the clamp in
-- getFullRakeConfig. NOT VALID so they bind new writes immediately without a
-- validation pass over 56k live rows.

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.tables ALTER COLUMN rake_percent SET DEFAULT -1;
ALTER TABLE public.tables ALTER COLUMN rake_cap_bb  SET DEFAULT -1;
ALTER TABLE public.clubs  ALTER COLUMN default_rake_percent SET DEFAULT -1;
ALTER TABLE public.clubs  ALTER COLUMN rake_cap             SET DEFAULT -1;

ALTER TABLE public.tables
  ADD CONSTRAINT tables_rake_percent_range
    CHECK (rake_percent IS NULL OR rake_percent = -1 OR (rake_percent >= 0 AND rake_percent <= 10))
    NOT VALID,
  ADD CONSTRAINT tables_rake_cap_bb_range
    CHECK (rake_cap_bb IS NULL OR rake_cap_bb = -1 OR (rake_cap_bb >= 0 AND rake_cap_bb <= 10))
    NOT VALID;

ALTER TABLE public.clubs
  ADD CONSTRAINT clubs_default_rake_percent_range
    CHECK (default_rake_percent IS NULL OR default_rake_percent = -1
           OR (default_rake_percent >= 0 AND default_rake_percent <= 10))
    NOT VALID,
  ADD CONSTRAINT clubs_rake_cap_range
    CHECK (rake_cap IS NULL OR rake_cap = -1 OR (rake_cap >= 0 AND rake_cap <= 10))
    NOT VALID;
