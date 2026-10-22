-- 20261022120113_club_data_chicago_days_load_early_october.sql
--
-- Version reserved by scripts/new-migration.mjs against origin/main and every
-- remote branch, so it cannot collide with another agent's in-flight work.
--
-- CLUB DATA CHICAGO DAYS: THE ONE-TIME HISTORY LOAD, OCTOBER 1 TO 12
--
-- 20261022103651 added the America/Chicago day bucket for Club Data and Union
-- Data and made the live money writer fill it from its cutover. This loads
-- twelve full October days into it, one UTC day per call of fn_ca_club_data_ct_seed,
-- exactly as that function's header describes: each UTC day's facts are split
-- at Chicago midnight, so every club, game and player keeps exactly the totals
-- the UTC report had and only the day moves. Days are loaded in three
-- migrations so each stays well inside the installer's fifteen minutes
-- (measured ~30 s for the heaviest day's slice).
--
-- Report-only: it writes ca_club_data_fact_ct, ca_club_data_game_ct,
-- ca_club_data_hands_ct and ca_club_data_ct_seed_log and nothing else; it
-- takes no lock a money writer waits on (every row it writes carries src = 1,
-- which the live writer never writes). A day already loaded refuses, so this
-- cannot run twice. No DDL. Nothing schedules it.
--
-- @live-proof: EXISTS (SELECT 1 FROM public.ca_club_data_ct_seed_log l WHERE l.utc_day = '2026-10-01'::date)

BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '780s';

DO $load$
DECLARE d date; r jsonb; n int := 0;
BEGIN
  IF current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'club data migration requires the maintained installer';
  END IF;
  IF to_regprocedure('public.fn_ca_club_data_ct_seed(date)') IS NULL THEN
    RAISE EXCEPTION 'Club Data Chicago facts (20261022103651) are not installed';
  END IF;
  IF date '2026-10-01' - 1 >= public.fn_ca_club_data_facts_from()
     AND NOT EXISTS (SELECT 1 FROM public.ca_club_data_ct_seed_log l WHERE l.utc_day = date '2026-10-01' - 1) THEN
    RAISE EXCEPTION 'load the previous Chicago history migration first';
  END IF;
  FOR d IN SELECT g::date FROM generate_series(GREATEST(date '2026-10-01', public.fn_ca_club_data_facts_from()), date '2026-10-12', interval '1 day') g LOOP
    r := public.fn_ca_club_data_ct_seed(d);
    n := n + 1;
    RAISE NOTICE 'Club Data Chicago day load: %', r;
  END LOOP;
  RAISE NOTICE 'Club Data Chicago day load: % UTC days loaded', n;
END $load$;

COMMIT;
