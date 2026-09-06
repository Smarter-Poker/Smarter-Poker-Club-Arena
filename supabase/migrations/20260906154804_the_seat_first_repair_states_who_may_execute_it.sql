-- THE SEAT-FIRST REPAIR STATES WHO MAY EXECUTE IT - AND THE CHECK THAT SAID
-- SO FOR THE OTHER THREE IS CORRECTED, BECAUSE IT PROVED NOTHING.
--
-- TWO THINGS, one found by the other.
--
-- 1. `check-definer-authorization` blocked the push carrying 20260906154248,
--    correctly and for the sixth time today: that migration replaces a
--    SECURITY DEFINER function that WRITES and says nothing about who may call
--    it, so a replay onto a database where it does not yet exist would create
--    it with EXECUTE held by PUBLIC. fn_repair_seat_first_games is the
--    checker's own worked example of case 1 - "almost always true for a
--    backfill, a sweep or a repair pass". It creates tables, seats horses,
--    registers them and moves start times; its only caller is
--    TournamentRecurringService.repairSeatFirstGames() on the engine's tick.
--
-- 2. WRITING THAT REVOKE IS HOW I FOUND THAT 20260906153725's PROOF WAS
--    VACUOUS. That migration stated the grants for the other three functions
--    and then "verified" them with
--
--      WHERE (p.proname, pg_get_function_identity_arguments(p.oid)) IN (
--              ('fn_sync_tournament_chips', 'uuid, jsonb'), ...)
--
--    pg_get_function_identity_arguments returns the parameter NAMES as well as
--    the types - 'p_tournament_id uuid, p_updates jsonb', not 'uuid, jsonb'.
--    So the IN matched nothing, the FOR loop ran ZERO times, every assertion
--    inside it was skipped, and the migration printed
--    DEFINER_GRANTS_STATED having checked no function at all. The REVOKE and
--    GRANT statements themselves were correct and did apply - Postgres
--    resolves `FUNCTION public.f(uuid, jsonb)` by type, which is why the live
--    grants are right - but the proof beside them was empty. Exactly the
--    failure this programme keeps meeting: a check that answers confidently
--    when it has not looked (CLAUDE.md 10.86).
--
--    It is corrected forward rather than edited: 20260906153725 stays
--    byte-identical to what ran, and this migration re-asserts all four
--    functions with a predicate that matches.
--
-- LIVE STATE, read immediately before writing this (15:48 UTC):
--
--   fn_repair_seat_first_games        {postgres, service_role}  auth=f anon=f
--   fn_seat_horse_in_seat_first_game  {postgres, service_role}  auth=f anon=f
--   fn_settle_tournament_rake         {postgres, service_role}  auth=f anon=f
--   fn_sync_tournament_chips          {postgres, service_role}  auth=f anon=f
--
-- All four are already closed, by the [autorevoke] event trigger on this
-- database. That net is not in the repo, which is why the files must say it.
-- PUBLIC is named alongside both browser roles: a REVOKE naming only
-- `authenticated` while PUBLIC still holds EXECUTE reads as a fix and does
-- nothing.

BEGIN;

REVOKE ALL ON FUNCTION public.fn_repair_seat_first_games(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_repair_seat_first_games(integer)
  TO service_role;

-- ---------------------------------------------------------------------------
-- PROVE IT, for all four, with a predicate that actually matches - and refuse
-- to pass if it matches fewer than four.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE r record; v_seen int := 0;
BEGIN
  FOR r IN
    SELECT p.oid, p.proname, pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_proc p
     WHERE p.pronamespace = 'public'::regnamespace
       AND p.proname IN ('fn_sync_tournament_chips',
                         'fn_settle_tournament_rake',
                         'fn_seat_horse_in_seat_first_game',
                         'fn_repair_seat_first_games')
  LOOP
    v_seen := v_seen + 1;
    IF NOT has_function_privilege('service_role', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED: the engine can no longer execute %(%)', r.proname, r.args;
    END IF;
    IF has_function_privilege('authenticated', r.oid, 'EXECUTE')
       OR has_function_privilege('anon', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION 'VERIFY FAILED: a browser role can execute %(%)', r.proname, r.args;
    END IF;
  END LOOP;

  /* THE COUNT IS THE POINT. Without it this block is the one it exists to
     correct: a loop over an empty set that reports success. */
  IF v_seen <> 4 THEN
    RAISE EXCEPTION 'VERIFY FAILED: expected to check 4 functions, checked % - the predicate matches nothing again', v_seen;
  END IF;

  RAISE NOTICE 'DEFINER_GRANTS_STATED_AND_ACTUALLY_CHECKED % function(s): engine only, no browser role holds EXECUTE', v_seen;
END $verify$;

COMMIT;
