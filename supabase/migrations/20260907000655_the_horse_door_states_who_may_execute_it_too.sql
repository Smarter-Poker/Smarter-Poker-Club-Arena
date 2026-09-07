-- THE HORSE DOOR STATES WHO MAY EXECUTE IT TOO.
--
-- `scripts/ci/check-definer-authorization.mjs` blocked the push that carried
-- 20260906233722, and it was right to. That migration replaces
-- `fn_register_horse_for_tournament` - SECURITY DEFINER, it writes wallets,
-- entries and rake records - and says nothing about who may call it. The
-- checker starts from the Postgres default, EXECUTE held by PUBLIC, and reads
-- a file that never revokes as a file that leaves the function open to any
-- browser.
--
-- THE LIVE DATABASE IS NOT OPEN, measured 2026-09-07 00:03 UTC right after
-- that migration applied:
--
--   fn_register_horse_for_tournament   authenticated=false anon=false
--                                      service_role=true
--
-- and two things kept it that way, neither of which belongs in a file: CREATE
-- OR REPLACE preserves an existing function's ACL, and this database carries
-- an [autorevoke] event trigger that strips PUBLIC and anon EXECUTE from a
-- function as it is created (its NOTICE is in that migration's apply log). A
-- repo that relies on either is a repo whose files do not mean what they say -
-- a replay onto a database without that event trigger would create the
-- function wide open.
--
-- This is the same correction 20260906153725 made for the three lock-order
-- functions, and it is worth saying why the pattern keeps recurring: an
-- agent replacing a function to fix its LOGIC is not thinking about its ACL,
-- and nothing in the function body mentions one. The checker is the only
-- thing that asks.
--
-- OPTION 1 FROM THE CHECKER'S OWN REMEDY, because nobody in a browser should
-- call it: it registers a horse for a tournament, debiting a club wallet and
-- writing a rake record for it. Every caller is the engine or a server service
-- (`TournamentManagerBase`, `TournamentRecurringService`,
-- `ScheduledTournamentService`, `tournamentRecovery`), all running with the
-- service role. PUBLIC is named alongside the two browser roles, because a
-- REVOKE that names only `authenticated` while PUBLIC still holds EXECUTE
-- reads as a fix and does nothing.
--
-- No behaviour changes. On this database every statement below is a no-op that
-- asserts the state already holds; on any other, it is the fix. GRANT and
-- REVOKE do not fire pgrst_ddl_watch, so this costs no schema reload.

BEGIN;

REVOKE ALL ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_register_horse_for_tournament(uuid, uuid)
  TO service_role;

DO $verify$
DECLARE v_oid oid;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname = 'fn_register_horse_for_tournament'
     AND pg_get_function_identity_arguments(p.oid) LIKE '%uuid%uuid%';
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'ABORT: fn_register_horse_for_tournament is not there to grant';
  END IF;

  IF NOT has_function_privilege('service_role', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: the engine can no longer seat a horse';
  END IF;
  IF has_function_privilege('authenticated', v_oid, 'EXECUTE')
     OR has_function_privilege('anon', v_oid, 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAILED: a browser role can still execute the horse door';
  END IF;

  RAISE NOTICE 'HORSE_DOOR_STATED engine only; no browser role holds EXECUTE';
END $verify$;

COMMIT;
