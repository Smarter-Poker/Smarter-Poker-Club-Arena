-- BACKFILLED 2026-09-27 from supabase_migrations.schema_migrations.statements.
-- Applied to production as 20260720160649 "drop_legacy_club_tournaments_20260720"; the .sql file was never committed
-- at the time. Everything below this header is byte-exact to what ran:
-- md5 58244f922ba7ffa1d2cb091c4afd6485 of array_to_string(statements, chr(10)) || chr(10).
-- Do NOT re-apply; it is already live.

-- Phase 3 of the club_tournaments retirement (Dan-approved 2026-07-20).
-- Pre-flight assertions: abort if reality differs from what was audited.
DO $$
DECLARE
  v_ct_rows int;
  v_te_rows int;
  v_md_rows int;
  v_rr_tid  int;
BEGIN
  SELECT count(*) INTO v_ct_rows FROM public.club_tournaments;
  IF v_ct_rows > 6 THEN
    RAISE EXCEPTION 'club_tournaments has % rows (expected <= 6 E2E test rows) — aborting', v_ct_rows;
  END IF;
  SELECT count(*) INTO v_te_rows FROM public.tournament_entries;
  IF v_te_rows > 0 THEN
    RAISE EXCEPTION 'tournament_entries is not empty (% rows) — aborting', v_te_rows;
  END IF;
  SELECT count(*) INTO v_md_rows FROM public.tournament_mystery_draws;
  IF v_md_rows > 0 THEN
    RAISE EXCEPTION 'tournament_mystery_draws is not empty (% rows) — aborting', v_md_rows;
  END IF;
  SELECT count(*) INTO v_rr_tid FROM public.rake_records WHERE tournament_id IS NOT NULL;
  IF v_rr_tid > 0 THEN
    RAISE EXCEPTION 'rake_records has % rows with non-null tournament_id (expected 0) — aborting', v_rr_tid;
  END IF;
END $$;

ALTER TABLE public.rake_records DROP CONSTRAINT IF EXISTS rake_records_tournament_id_fkey;
ALTER TABLE public.rake_records
  ADD CONSTRAINT rake_records_tournament_id_fkey
  FOREIGN KEY (tournament_id) REFERENCES public.tournaments(id) ON DELETE SET NULL;

DROP TABLE IF EXISTS public.tournament_mystery_draws;
DROP TABLE IF EXISTS public.tournament_entries;
DROP TABLE IF EXISTS public.club_tournaments;
