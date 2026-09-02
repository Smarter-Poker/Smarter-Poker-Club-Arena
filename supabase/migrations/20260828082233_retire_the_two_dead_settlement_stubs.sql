-- RETIRE THE TWO DEAD SETTLEMENT STUBS.
--
-- 20260826140030_proper_settlement_locks.sql replaced four settlement functions
-- with `RAISE EXCEPTION '... original body was lost ... Rebuild required.'`
-- Two of them - rounds 2 and 3 of the cascade - were restored from migration
-- history by 20260828080906. These are the other two, and they get the opposite
-- treatment, for a reason:
--
--   fn_finalize_settlement_period(p_id, p_status, p_clubs_affected,
--       p_players_affected, p_total_rake, p_total_rakeback, p_summary,
--       p_error_detail)
--   fn_run_pending_rakeback_settlement()          -- the NO-ARGUMENT overload
--
-- NOTHING CALLS EITHER. Checked every surface: zero callers among the 2,255
-- functions in the database, zero cron jobs, zero references in the client or
-- the engine. The one live caller of that NAME,
-- SettlementService.runPendingRakebackSettlement, passes `p_max_clubs` and so
-- resolves to the OTHER overload - fn_run_pending_rakeback_settlement(
-- p_max_clubs integer DEFAULT 100), which was never damaged.
--
-- THE NO-ARG STUB IS AN ACTIVE HAZARD, not merely dead. Its sibling declares a
-- DEFAULT, so a zero-argument call matches BOTH candidates and Postgres refuses
-- it as ambiguous - "function fn_run_pending_rakeback_settlement() is not
-- unique". The stub does not just fail to work; it makes the working function
-- unreachable by that call shape. Dropping it repairs that path.
--
-- WHY RETIRE RATHER THAN RESTORE. fn_finalize_settlement_period's archived body
-- (20260420011713) declares a DIFFERENT signature from the live stub, so
-- applying it would leave the 8-argument stub in place and add a second
-- overload beside it - a probe caught exactly that and refused. Restoring means
-- reconciling a four-month-old signature to resurrect a function with an empty
-- caller list. Same doctrine as retiring the auto-settler earlier today: a
-- function that only raises is not documentation, it is a trap for the next
-- reader.
--
-- ROLLBACK
--   Stub bodies are in 20260826140030; archived real bodies are in migration
--   history (20260420011713 and 20260729171430). Nothing here loses anything.

DROP FUNCTION IF EXISTS public.fn_run_pending_rakeback_settlement();
DROP FUNCTION IF EXISTS public.fn_finalize_settlement_period(
  uuid, text, integer, integer, numeric, numeric, jsonb, text);

DO $post$
DECLARE v_stubs int; v_working int;
BEGIN
  SELECT count(*) INTO v_stubs FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace
     AND p.prosrc LIKE '%original body was lost due to prior agent destruction%';
  IF v_stubs > 0 THEN
    RAISE EXCEPTION '% destroyed stub(s) still present', v_stubs;
  END IF;

  SELECT count(*) INTO v_working FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace
     AND p.proname='fn_run_pending_rakeback_settlement';
  IF v_working <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 fn_run_pending_rakeback_settlement, found %', v_working;
  END IF;
  IF (SELECT length(prosrc) FROM pg_proc
       WHERE pronamespace='public'::regnamespace
         AND proname='fn_run_pending_rakeback_settlement') < 1000 THEN
    RAISE EXCEPTION 'the surviving fn_run_pending_rakeback_settlement is not the real body';
  END IF;
  IF (SELECT min(length(prosrc)) FROM pg_proc
       WHERE pronamespace='public'::regnamespace
         AND proname IN ('fn_settle_round2_club_to_agents','fn_settle_round3_agents_to_players')) < 1000 THEN
    RAISE EXCEPTION 'a restored settlement round reverted to a stub';
  END IF;
END
$post$;
