-- ============================================================================
-- 20260831030000_run_it_mode_describes_what_the_table_actually_does.sql
-- TIER: 2 | AFFECTS: tables.run_it_mode (descriptive only) + a new guard on
-- auto_start_players. Applied to production via the Supabase MCP 2026-08-31.
--
-- CONTEXT (2026-08-31 create-table audit). TableConfigPage wrote only
-- run_it_twice_enabled from its "Run It Multi-Times" radio, while the engine
-- gate is
--    ((run_it_twice ?? true) AND (allow_run_it_twice ?? true)) OR run_it_twice_enabled
-- and the first two columns default to true. So 921 of 924 live cash tables
-- were RUNNING run-it-twice while their run_it_mode read 'none'. The page now
-- writes all three columns.
--
-- 1. BACKFILL, DESCRIPTIVE ONLY - NO BEHAVIOUR CHANGE. Rows whose booleans
--    say run-it-twice is ON but whose mode says 'none' are relabelled
--    'player_choice', which is what they have always actually done. The
--    engine treats 'none' and 'player_choice' identically
--    (RunItTwiceEngine.mandatoryRuns returns 0 for both = "players decide")
--    and the booleans are NOT touched, so no table changes behaviour. It only
--    stops the row describing itself as something it is not, now that 'none'
--    genuinely means off.
--
-- 2. NEW GUARD. auto_start_players above the seat count is a table that can
--    never deal and is not even flagged as stuck (the same number is
--    dealThreshold, which the zombie reaper reads). The UI now clamps it; the
--    database refuses it, the way it already refuses the seat law.
--
-- ROLLBACK for (1): none needed - it changes no behaviour. To undo the label:
--   UPDATE public.tables SET run_it_mode='none'
--    WHERE run_it_mode='player_choice' AND tournament_id IS NULL;
-- ============================================================================

DO $$
DECLARE v_rows int;
BEGIN
  UPDATE public.tables
     SET run_it_mode = 'player_choice'
   WHERE tournament_id IS NULL
     AND COALESCE(is_deleted, false) = false
     AND COALESCE(run_it_mode, 'none') = 'none'
     AND ((COALESCE(run_it_twice, true) AND COALESCE(allow_run_it_twice, true))
          OR COALESCE(run_it_twice_enabled, false));
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RAISE NOTICE 'run_it_mode relabelled on % table(s) (descriptive only)', v_rows;
END $$;

CREATE OR REPLACE FUNCTION public.fn_tables_autostart_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.tournament_id IS NULL
     AND NEW.auto_start_players IS NOT NULL
     AND NEW.max_players IS NOT NULL
     AND NEW.auto_start_players > NEW.max_players THEN
    RAISE EXCEPTION
      'auto_start_players (%) cannot exceed max_players (%) - the table would never deal',
      NEW.auto_start_players, NEW.max_players;
  END IF;
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_tables_autostart_guard ON public.tables;
CREATE TRIGGER trg_tables_autostart_guard
  BEFORE INSERT OR UPDATE OF auto_start_players, max_players ON public.tables
  FOR EACH ROW EXECUTE FUNCTION public.fn_tables_autostart_guard();

REVOKE ALL ON FUNCTION public.fn_tables_autostart_guard() FROM PUBLIC, anon, authenticated;

DO $$
DECLARE v_bad int; v_mismatch int;
BEGIN
  SELECT count(*) INTO v_bad FROM public.tables
   WHERE tournament_id IS NULL AND COALESCE(is_deleted,false)=false
     AND auto_start_players IS NOT NULL AND max_players IS NOT NULL
     AND auto_start_players > max_players;
  IF v_bad > 0 THEN
    RAISE EXCEPTION 'still % table(s) with auto_start_players over the seat count', v_bad;
  END IF;

  SELECT count(*) INTO v_mismatch FROM public.tables
   WHERE tournament_id IS NULL AND COALESCE(is_deleted,false)=false
     AND COALESCE(run_it_mode,'none') = 'none'
     AND ((COALESCE(run_it_twice,true) AND COALESCE(allow_run_it_twice,true))
          OR COALESCE(run_it_twice_enabled,false));
  IF v_mismatch > 0 THEN
    RAISE EXCEPTION '% table(s) still say none while running it twice', v_mismatch;
  END IF;
END $$;
